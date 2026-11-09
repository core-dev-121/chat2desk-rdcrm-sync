import { describe, expect, it } from 'vitest';
import { buildHarness } from '../src/harness.js';

const PHONE = '+55 11 98888-7777';
const CLIENT = 'c2d-client-1';

describe('R1 · contato novo chama direto', () => {
  it('cria contato e negociação na etapa inicial', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE, 'Maria Souza');
    await h.queue.idle();

    expect(h.crm.contacts.size).toBe(1);
    const [deal] = [...h.crm.deals.values()];
    expect(deal?.stageId).toBe(h.config.initialStageId);
    expect([...h.crm.contacts.values()][0]?.phones).toEqual(['5511988887777']);
  });

  it('nova mensagem do mesmo número não cria outra (nem chegando ao mesmo tempo)', async () => {
    const h = buildHarness();
    await Promise.all([
      h.c2d.message(CLIENT, PHONE, 'Maria'),
      h.c2d.message(CLIENT, PHONE, 'Maria'),
      h.c2d.message(CLIENT, '551188887777', 'Maria'),
    ]);
    await h.c2d.message(CLIENT, PHONE, 'Maria');
    await h.queue.idle();

    expect(h.crm.calls.createContact).toBe(1);
    expect(h.crm.calls.createDeal).toBe(1);
  });
});

describe('R2 · etiqueta de prioridade', () => {
  it('move a negociação para a etapa 2', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();
    await h.c2d.tag(CLIENT, PHONE, h.config.priorityTagId);
    await h.queue.idle();

    expect([...h.crm.deals.values()][0]?.stageId).toBe(h.config.priorityStageId);
  });

  it('etiqueta repetida não move de novo', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();
    await h.c2d.tag(CLIENT, PHONE, h.config.priorityTagId);
    await h.queue.idle();
    // consultor avança a negociação no CRM e depois a etiqueta é aplicada de novo
    const deal = [...h.crm.deals.values()][0]!;
    await h.crm.consultantMovesDeal(deal.id, 'stage-proposta');
    await h.queue.idle();
    await h.c2d.tag(CLIENT, PHONE, h.config.priorityTagId);
    await h.queue.idle();

    expect(h.crm.calls.updateDealStage).toBe(1);
    expect(deal.stageId).toBe('stage-proposta');
  });

  it('etiquetas do fluxo n8n são ignoradas', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE);
    await h.c2d.tag(CLIENT, PHONE, 'tag-n8n-conversao');
    await h.queue.idle();

    expect(h.crm.calls.updateDealStage).toBe(0);
    expect(h.outcomes.some((o) => o.reason?.includes('n8n'))).toBe(true);
  });
});

describe('R3 · campo muda no Chat2Desk', () => {
  it('atualiza contato/negociação; campo vazio não apaga valor preenchido', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE);
    await h.c2d.fields(CLIENT, PHONE, { destino: 'Lisboa', num_pessoas: '4', campo_nao_mapeado: 'x' });
    await h.queue.idle();
    await h.c2d.fields(CLIENT, PHONE, { destino: '', num_pessoas: null });
    await h.queue.idle();

    const deal = [...h.crm.deals.values()][0]!;
    const contact = [...h.crm.contacts.values()][0]!;
    expect(deal.fields).toEqual({ destino: 'Lisboa', num_pessoas: '4' });
    expect(contact.fields).toEqual({ destino: 'Lisboa' });
  });
});

describe('R4 · conversa termina', () => {
  it('grava a nota com data e canal uma única vez', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE);
    await h.c2d.close(CLIENT, PHONE, 'dialog-77', 'Quer pacote para Lisboa em maio, 4 pessoas.');
    await h.c2d.close(CLIENT, PHONE, 'dialog-77', 'Quer pacote para Lisboa em maio, 4 pessoas.');
    await h.queue.idle();

    expect(h.crm.notes).toHaveLength(1);
    expect(h.crm.notes[0]!.text).toMatch(/Canal: WhatsApp/);
    expect(h.crm.notes[0]!.text).toMatch(/Data: 09\/11\/2026/);
    expect(h.crm.notes[0]!.dealId).toBe([...h.crm.deals.keys()][0]);
  });
});

describe('R5 · etapa muda no CRM (bloqueio de eco)', () => {
  it('consultor muda a etapa -> chega ao atendimento, sem disparar R2 nem R3 de volta', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();
    const deal = [...h.crm.deals.values()][0]!;

    await h.crm.consultantMovesDeal(deal.id, 'stage-proposta');
    await h.queue.idle();

    expect(h.chat2desk.clients.get(CLIENT)?.fields.etapa_crm).toBe('Proposta enviada');
    expect(h.crm.calls.updateDealStage).toBe(0); // nada voltou para o CRM
  });

  it('R2 move a etapa -> o webhook do CRM que volta é reconhecido como eco', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();
    await h.c2d.tag(CLIENT, PHONE, h.config.priorityTagId);
    await h.queue.idle();

    const echo = h.outcomes.find((o) => o.rule === 'R5' && o.reason?.startsWith('eco'));
    expect(echo).toBeDefined();
    expect(h.chat2desk.clients.get(CLIENT)?.fields.etapa_crm).toBeUndefined();
  });

  it('modo etiqueta: a etiqueta aplicada pela integração não dispara a R2', async () => {
    const h = buildHarness({
      stageFeedback: { mode: 'tag', tagByStage: { 'stage-proposta': 'tag-etapa-proposta', 'stage-2': 'tag-prioridade' } },
    });
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();
    const deal = [...h.crm.deals.values()][0]!;

    // pior caso: a etapa 2 mapeada para a própria etiqueta de prioridade
    await h.crm.consultantMovesDeal(deal.id, 'stage-2');
    await h.queue.idle();

    expect(h.chat2desk.clients.get(CLIENT)?.tags.has('tag-prioridade')).toBe(true);
    expect(h.crm.calls.updateDealStage).toBe(0);
    expect(h.outcomes.some((o) => o.rule === 'R2' && o.reason?.startsWith('eco'))).toBe(true);
  });

  it('mudança legítima logo após um eco continua passando', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();
    await h.c2d.tag(CLIENT, PHONE, h.config.priorityTagId); // integração move para stage-2 (eco)
    await h.queue.idle();
    const deal = [...h.crm.deals.values()][0]!;
    await h.crm.consultantMovesDeal(deal.id, 'stage-fechado'); // consultor, segundos depois
    await h.queue.idle();

    expect(h.chat2desk.clients.get(CLIENT)?.fields.etapa_crm).toBe('Fechado');
  });
});

describe('R6 · cliente que volta', () => {
  it('reaproveita contato antigo gravado sem DDI e sem o nono dígito', async () => {
    const h = buildHarness();
    const old = h.crm.seedContact('Maria (cadastro antigo)', '1188887777');
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();

    expect(h.crm.calls.createContact).toBe(0);
    expect([...h.crm.deals.values()][0]?.contactId).toBe(old.id);
  });

  it('reaproveita a negociação aberta; cria nova só depois que a anterior fecha', async () => {
    const h = buildHarness();
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();
    expect(h.crm.calls.createDeal).toBe(1);

    [...h.crm.deals.values()][0]!.open = false; // negociação ganha/perdida
    await h.c2d.message(CLIENT, PHONE);
    await h.queue.idle();
    expect(h.crm.calls.createDeal).toBe(2);
    expect(h.crm.calls.createContact).toBe(1);
  });
});
