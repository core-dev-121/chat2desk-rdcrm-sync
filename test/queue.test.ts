import { describe, expect, it } from 'vitest';
import { buildHarness } from '../src/harness.js';

const PHONE = '+55 21 99999-0000';

describe('fila: novas tentativas, falhas e alerta', () => {
  it('instabilidade passageira no CRM: nova tentativa e nenhum evento perdido', async () => {
    const h = buildHarness();
    h.crm.failNextWrites = 2;
    await h.c2d.message('c1', PHONE, 'João');
    await h.queue.idle();

    expect(h.crm.contacts.size).toBe(1);
    expect(h.crm.deals.size).toBe(1);
    expect(h.alerts).toHaveLength(0);
    expect(h.queue.getStats()).toMatchObject({ processed: 1, retrying: 0, failed: 0 });
  });

  it('falha persistente: vai para a fila de falhas, alerta a equipe e pode ser reprocessada', async () => {
    const h = buildHarness({}, { maxAttempts: 3 });
    h.crm.failNextWrites = 99;
    await h.c2d.message('c1', PHONE, 'João');
    await h.queue.idle();

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.lastError).toMatch(/503/);
    expect(h.queue.getStats().failed).toBe(1);

    h.crm.failNextWrites = 0; // causa corrigida
    expect(h.queue.replayDeadLetters()).toBe(1);
    await h.queue.idle();
    expect(h.crm.contacts.size).toBe(1);
    expect(h.queue.getStats().failed).toBe(0);
  });

  it('falha no meio da R2 não deixa a etiqueta "travada" como já processada', async () => {
    const h = buildHarness();
    await h.c2d.message('c1', PHONE);
    await h.queue.idle();
    h.crm.failNextWrites = 1;
    await h.c2d.tag('c1', PHONE, h.config.priorityTagId);
    await h.queue.idle();

    expect([...h.crm.deals.values()][0]?.stageId).toBe(h.config.priorityStageId);
  });

  it('webhook reenviado com o mesmo id é descartado', async () => {
    const h = buildHarness();
    const e = { source: 'chat2desk' as const, type: 'message_in' as const, eventId: 'evt-1', clientId: 'c1', phone: PHONE };
    expect(await h.queue.enqueue(e)).toBe(true);
    expect(await h.queue.enqueue(e)).toBe(false);
    await h.queue.idle();
    expect(h.queue.getStats().duplicates).toBe(1);
  });
});
