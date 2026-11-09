/**
 * Monta a integração completa com os simuladores em memória, ligando os webhooks
 * dos simuladores de volta à fila — exatamente o laço onde o eco aconteceria.
 * Usado pelos testes e pela demo.
 */
import { randomUUID } from 'node:crypto';
import { InMemoryChat2Desk, InMemoryCrm } from './adapters/memory/index.js';
import { demoConfig, type IntegrationConfig } from './config.js';
import type { IntegrationEvent } from './events.js';
import { EventQueue, type FailedEvent } from './queue.js';
import { IntegrationRules, type Logger, type RuleOutcome } from './rules.js';
import { MemoryStore } from './store.js';

export function buildHarness(overrides: Partial<IntegrationConfig> = {}, opts: { maxAttempts?: number } = {}) {
  const config: IntegrationConfig = { ...demoConfig, ...overrides };
  const store = new MemoryStore();
  const outcomes: (RuleOutcome & { event: string })[] = [];
  const alerts: FailedEvent[] = [];
  const silent: Logger = { info: () => {}, warn: () => {} };

  let queue!: EventQueue;
  const toQueue = async (e: IntegrationEvent) => {
    await queue.enqueue(e);
  };

  const crm = new InMemoryCrm(toQueue);
  const chat2desk = new InMemoryChat2Desk(toQueue);
  const rules = new IntegrationRules({ crm, chat2desk, store, config, logger: silent });

  queue = new EventQueue({
    store,
    baseDelayMs: 1,
    maxAttempts: opts.maxAttempts ?? 4,
    handler: async (e) => {
      const r = await rules.handle(e);
      outcomes.push({ ...r, event: `${e.source}/${e.type}` });
    },
    onDeadLetter: (f) => {
      alerts.push(f);
    },
  });

  /** Atalhos que simulam o que acontece no Chat2Desk (como chegaria pelo webhook). */
  const c2d = {
    message: (clientId: string, phone: string, name?: string) => {
      chat2desk.register(clientId, phone);
      return queue.enqueue({ source: 'chat2desk', type: 'message_in', eventId: randomUUID(), clientId, phone, name });
    },
    tag: (clientId: string, phone: string, tagId: string) =>
      queue.enqueue({ source: 'chat2desk', type: 'tag_added', eventId: randomUUID(), clientId, phone, tagId }),
    fields: (clientId: string, phone: string, fields: Record<string, string | null>) =>
      queue.enqueue({ source: 'chat2desk', type: 'fields_changed', eventId: randomUUID(), clientId, phone, fields }),
    close: (clientId: string, phone: string, dialogId: string, summary: string) =>
      queue.enqueue({
        source: 'chat2desk',
        type: 'dialog_closed',
        eventId: randomUUID(),
        clientId,
        phone,
        dialogId,
        summary,
        channel: 'WhatsApp',
        closedAt: '2026-11-09T15:30:00Z',
      }),
  };

  return { config, store, crm, chat2desk, rules, queue, outcomes, alerts, c2d };
}
