import type { IntegrationEvent } from './events.js';
import type { KeyValueStore } from './store.js';

/**
 * Fila de eventos com novas tentativas e fila de falhas (DLQ).
 *
 * O webhook só enfileira e responde 200 na hora; o processamento é assíncrono.
 * - Evento repetido (o mesmo eventId reenviado pela ferramenta) é descartado.
 * - Erro -> nova tentativa com espera exponencial.
 * - Esgotou as tentativas -> vai para a fila de falhas e dispara alerta. Nada some em silêncio.
 *
 * Esta implementação roda em processo e serve para a demo e os testes.
 * Em produção, a mesma interface fica sobre BullMQ/Redis (fila persistente: sobrevive a restart).
 */

export interface FailedEvent {
  event: IntegrationEvent;
  attempts: number;
  lastError: string;
  failedAt: string;
}

export interface QueueStats {
  received: number;
  duplicates: number;
  processed: number;
  retrying: number;
  failed: number;
  pending: number;
}

export interface EventQueueOptions {
  handler: (e: IntegrationEvent) => Promise<unknown>;
  store: KeyValueStore;
  onDeadLetter: (f: FailedEvent) => Promise<void> | void;
  maxAttempts?: number;
  baseDelayMs?: number;
  concurrency?: number;
}

export class EventQueue {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly concurrency: number;
  private ready: { event: IntegrationEvent; attempt: number }[] = [];
  private running = 0;
  private timers = new Set<NodeJS.Timeout>();
  private idleWaiters: (() => void)[] = [];
  readonly deadLetters: FailedEvent[] = [];
  private stats: QueueStats = { received: 0, duplicates: 0, processed: 0, retrying: 0, failed: 0, pending: 0 };

  constructor(private readonly opts: EventQueueOptions) {
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.baseDelayMs = opts.baseDelayMs ?? 2_000;
    this.concurrency = opts.concurrency ?? 4;
  }

  /** Retorna false se o evento já tinha sido recebido (reenvio do webhook). */
  async enqueue(event: IntegrationEvent): Promise<boolean> {
    this.stats.received++;
    const fresh = await this.opts.store.setIfAbsent(`seen:${event.source}:${event.eventId}`, '1', 7 * 24 * 3600_000);
    if (!fresh) {
      this.stats.duplicates++;
      return false;
    }
    this.ready.push({ event, attempt: 1 });
    this.pump();
    return true;
  }

  getStats(): QueueStats {
    return { ...this.stats, pending: this.ready.length + this.running + this.timers.size };
  }

  /** Resolve quando não há nada em execução, na fila ou aguardando nova tentativa. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private isIdle() {
    return this.ready.length === 0 && this.running === 0 && this.timers.size === 0;
  }

  private pump() {
    while (this.running < this.concurrency && this.ready.length) {
      const job = this.ready.shift()!;
      this.running++;
      void this.run(job.event, job.attempt).finally(() => {
        this.running--;
        this.pump();
        if (this.isIdle()) this.idleWaiters.splice(0).forEach((r) => r());
      });
    }
  }

  private async run(event: IntegrationEvent, attempt: number) {
    try {
      await this.opts.handler(event);
      this.stats.processed++;
      if (attempt > 1) this.stats.retrying--;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= this.maxAttempts) {
        if (attempt > 1) this.stats.retrying--;
        this.stats.failed++;
        const failed: FailedEvent = { event, attempts: attempt, lastError: message, failedAt: new Date().toISOString() };
        this.deadLetters.push(failed);
        await this.opts.onDeadLetter(failed);
        return;
      }
      if (attempt === 1) this.stats.retrying++;
      const delay = this.baseDelayMs * 2 ** (attempt - 1);
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.ready.push({ event, attempt: attempt + 1 });
        this.pump();
      }, delay);
      this.timers.add(t);
    }
  }

  /** Reprocessa manualmente tudo o que está na fila de falhas (após corrigir a causa). */
  replayDeadLetters(): number {
    const items = this.deadLetters.splice(0);
    for (const f of items) {
      this.stats.failed--;
      this.ready.push({ event: f.event, attempt: 1 });
    }
    this.pump();
    return items.length;
  }
}
