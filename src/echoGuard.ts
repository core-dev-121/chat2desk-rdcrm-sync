import type { KeyValueStore } from './store.js';

/**
 * Bloqueio de eco (requisito "o que a integração grava não pode disparar a regra de volta").
 *
 * Antes de cada escrita, a integração registra uma assinatura do que vai gravar
 * (ex.: "negociação 123 foi para a etapa X"). Quando o webhook correspondente volta,
 * a assinatura é encontrada e consumida, e o evento é descartado.
 *
 * - A assinatura inclui o VALOR gravado: se um consultor mudar a mesma negociação para
 *   outra etapa logo depois, o evento dele não bate com a marca e é processado normalmente.
 * - TTL curto (padrão 10 min): uma marca que nunca voltou expira sozinha e não bloqueia nada.
 * - Consumo único: a marca vale para um eco só.
 */
export class EchoGuard {
  constructor(private readonly store: KeyValueStore, private readonly ttlMs = 10 * 60_000) {}

  async markOwnWrite(signature: string): Promise<void> {
    await this.store.set(`echo:${signature}`, '1', this.ttlMs);
  }

  /** true = o evento foi gerado pela própria integração e deve ser ignorado. */
  async consumeIfEcho(signature: string): Promise<boolean> {
    return (await this.store.take(`echo:${signature}`)) !== null;
  }

  /** Desfaz a marca quando a escrita falha (para não engolir um evento legítimo depois). */
  async unmark(signature: string): Promise<void> {
    await this.store.del(`echo:${signature}`);
  }
}

export const echoSig = {
  crmDealStage: (dealId: string, stageId: string) => `crm:deal:${dealId}:stage:${stageId}`,
  c2dTag: (clientId: string, tagId: string) => `c2d:client:${clientId}:tag:${tagId}`,
  c2dField: (clientId: string, field: string, value: string) =>
    `c2d:client:${clientId}:field:${field}:${value}`,
};
