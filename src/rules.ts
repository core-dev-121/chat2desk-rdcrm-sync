import type { IntegrationConfig } from './config.js';
import { EchoGuard, echoSig } from './echoGuard.js';
import type { Chat2DeskEvent, CrmEvent, IntegrationEvent } from './events.js';
import { KeyedMutex } from './mutex.js';
import { normalizePhone, phoneLookupVariants } from './phone.js';
import type { Chat2DeskPort, CrmContact, CrmDeal, CrmPort } from './ports.js';
import type { KeyValueStore } from './store.js';

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

export interface RuleOutcome {
  rule: RuleId;
  status: 'applied' | 'skipped';
  reason?: string;
  dealId?: string;
}

export interface Logger {
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
}

export const consoleLogger: Logger = {
  info: (m, meta) => console.log(JSON.stringify({ level: 'info', msg: m, ...meta })),
  warn: (m, meta) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...meta })),
};

const LINK_TTL_MS = 180 * 24 * 60 * 60_000; // vínculo negociação -> cliente do Chat2Desk: 180 dias
const ONCE_TTL_MS = 365 * 24 * 60 * 60_000;

export class IntegrationRules {
  private readonly echo: EchoGuard;
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly deps: {
      crm: CrmPort;
      chat2desk: Chat2DeskPort;
      store: KeyValueStore;
      config: IntegrationConfig;
      logger?: Logger;
    },
  ) {
    this.echo = new EchoGuard(deps.store, deps.config.echoTtlMs);
  }

  private get log() {
    return this.deps.logger ?? consoleLogger;
  }

  async handle(event: IntegrationEvent): Promise<RuleOutcome> {
    if (event.source === 'rdcrm') return this.onCrmStageChanged(event);
    switch (event.type) {
      case 'message_in':
        return this.onMessageIn(event);
      case 'tag_added':
        return this.onTagAdded(event);
      case 'fields_changed':
        return this.onFieldsChanged(event);
      case 'dialog_closed':
        return this.onDialogClosed(event);
    }
  }

  // ---------------------------------------------------------------- R1 + R6

  /**
   * Busca antes de criar, sempre pelo telefone padronizado e suas variações.
   * Reaproveita a negociação aberta; cria nova só se não houver (R6).
   * Serializado por telefone para duas mensagens simultâneas não criarem dois contatos (R1).
   */
  async resolveContactAndDeal(
    rawPhone: string,
    name: string | undefined,
    clientId: string,
  ): Promise<{ contact: CrmContact; deal: CrmDeal; created: { contact: boolean; deal: boolean } }> {
    const phone = normalizePhone(rawPhone);
    return this.mutex.run(phone, async () => {
      const { crm, store, config } = this.deps;
      const created = { contact: false, deal: false };

      const found = await crm.findContactsByPhones(phoneLookupVariants(phone));
      if (found.length > 1) {
        this.log.warn('Telefone com mais de um contato no CRM; usando o primeiro', {
          phone,
          contactIds: found.map((c) => c.id),
        });
      }
      let contact = found[0];
      if (!contact) {
        contact = await crm.createContact({ name: name?.trim() || phone, phone });
        created.contact = true;
      }

      let deal = (await crm.findOpenDeals(contact.id))[0];
      if (!deal) {
        deal = await crm.createDeal({
          contactId: contact.id,
          name: `${config.dealNamePrefix} - ${contact.name}`,
          stageId: config.initialStageId,
        });
        created.deal = true;
        // Se o CRM avisar a etapa da negociação recém-criada, não é mudança de etapa de verdade.
        await this.echo.markOwnWrite(echoSig.crmDealStage(deal.id, config.initialStageId));
      }

      await store.set(`link:deal:${deal.id}`, clientId, LINK_TTL_MS);
      return { contact, deal, created };
    });
  }

  private async onMessageIn(e: Extract<Chat2DeskEvent, { type: 'message_in' }>): Promise<RuleOutcome> {
    const { deal, created } = await this.resolveContactAndDeal(e.phone, e.name, e.clientId);
    if (created.contact || created.deal) {
      this.log.info('R1: contato/negociação criados', { dealId: deal.id, ...created });
      const reason = created.contact ? 'contato e negociação criados' : 'contato existente reaproveitado (R6), negociação criada';
      return { rule: 'R1', status: 'applied', reason, dealId: deal.id };
    }
    return { rule: 'R6', status: 'skipped', reason: 'contato e negociação aberta já existem', dealId: deal.id };
  }

  // ---------------------------------------------------------------- R2

  private async onTagAdded(e: Extract<Chat2DeskEvent, { type: 'tag_added' }>): Promise<RuleOutcome> {
    const { config, crm, store } = this.deps;

    if (config.ignoredTagIds.includes(e.tagId)) {
      return { rule: 'R2', status: 'skipped', reason: 'etiqueta de outro fluxo (n8n)' };
    }
    if (await this.echo.consumeIfEcho(echoSig.c2dTag(e.clientId, e.tagId))) {
      return { rule: 'R2', status: 'skipped', reason: 'eco: etiqueta aplicada pela própria integração (R5)' };
    }
    if (e.tagId !== config.priorityTagId) {
      return { rule: 'R2', status: 'skipped', reason: 'etiqueta sem regra' };
    }

    const { deal } = await this.resolveContactAndDeal(e.phone, undefined, e.clientId);
    if (deal.stageId === config.priorityStageId) {
      return { rule: 'R2', status: 'skipped', reason: 'negociação já está na etapa 2', dealId: deal.id };
    }

    const onceKey = `once:r2:${deal.id}`;
    if (!(await store.setIfAbsent(onceKey, e.eventId, ONCE_TTL_MS))) {
      return { rule: 'R2', status: 'skipped', reason: 'etiqueta repetida: já moveu esta negociação', dealId: deal.id };
    }

    const sig = echoSig.crmDealStage(deal.id, config.priorityStageId);
    await this.echo.markOwnWrite(sig);
    try {
      await crm.updateDealStage(deal.id, config.priorityStageId);
    } catch (err) {
      await this.echo.unmark(sig);
      await store.del(onceKey); // libera para a nova tentativa da fila
      throw err;
    }
    return { rule: 'R2', status: 'applied', dealId: deal.id };
  }

  // ---------------------------------------------------------------- R3

  private async onFieldsChanged(e: Extract<Chat2DeskEvent, { type: 'fields_changed' }>): Promise<RuleOutcome> {
    const { config, crm } = this.deps;
    const feedbackField = config.stageFeedback.mode === 'field' ? config.stageFeedback.field : undefined;

    const contactFields: Record<string, string> = {};
    const dealFields: Record<string, string> = {};
    let echoes = 0;

    for (const [field, raw] of Object.entries(e.fields)) {
      if (field === feedbackField) {
        // campo que só a própria integração escreve (R5): nunca volta para o CRM
        await this.echo.consumeIfEcho(echoSig.c2dField(e.clientId, field, (raw ?? '').trim()));
        echoes++;
        continue;
      }
      const map = config.fieldMap[field];
      if (!map) continue;
      const value = (raw ?? '').trim();
      if (!value) continue; // campo vazio nunca apaga valor preenchido
      if (await this.echo.consumeIfEcho(echoSig.c2dField(e.clientId, field, value))) {
        echoes++;
        continue;
      }
      if (map.target !== 'deal') contactFields[map.crmField] = value;
      if (map.target !== 'contact') dealFields[map.crmField] = value;
    }

    if (!Object.keys(contactFields).length && !Object.keys(dealFields).length) {
      const reason = echoes
        ? 'eco: campo gravado pela própria integração (R5)'
        : 'nenhum campo mapeado com valor (vazio não apaga o CRM)';
      return { rule: 'R3', status: 'skipped', reason };
    }

    const { contact, deal } = await this.resolveContactAndDeal(e.phone, undefined, e.clientId);
    if (Object.keys(contactFields).length) await crm.updateContactFields(contact.id, contactFields);
    if (Object.keys(dealFields).length) await crm.updateDealFields(deal.id, dealFields);
    return { rule: 'R3', status: 'applied', dealId: deal.id };
  }

  // ---------------------------------------------------------------- R4

  private async onDialogClosed(e: Extract<Chat2DeskEvent, { type: 'dialog_closed' }>): Promise<RuleOutcome> {
    const { crm, store } = this.deps;
    if (!e.summary.trim()) return { rule: 'R4', status: 'skipped', reason: 'atendimento encerrado sem resumo' };

    const { deal } = await this.resolveContactAndDeal(e.phone, undefined, e.clientId);
    const onceKey = `once:r4:${e.dialogId}`;
    if (!(await store.setIfAbsent(onceKey, deal.id, ONCE_TTL_MS))) {
      return { rule: 'R4', status: 'skipped', reason: 'resumo deste atendimento já registrado', dealId: deal.id };
    }

    const when = new Date(e.closedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const note = `Resumo do atendimento\nData: ${when}\nCanal: ${e.channel}\n\n${e.summary.trim()}`;
    try {
      await crm.addDealNote(deal.id, note);
    } catch (err) {
      await store.del(onceKey);
      throw err;
    }
    return { rule: 'R4', status: 'applied', dealId: deal.id };
  }

  // ---------------------------------------------------------------- R5

  private async onCrmStageChanged(e: CrmEvent): Promise<RuleOutcome> {
    const { config, chat2desk, store } = this.deps;

    if (await this.echo.consumeIfEcho(echoSig.crmDealStage(e.dealId, e.stageId))) {
      return { rule: 'R5', status: 'skipped', reason: 'eco: etapa alterada pela própria integração (R2)', dealId: e.dealId };
    }

    const clientId = await store.get(`link:deal:${e.dealId}`);
    if (!clientId) {
      return { rule: 'R5', status: 'skipped', reason: 'negociação sem atendimento vinculado', dealId: e.dealId };
    }

    // O CRM avisa qualquer alteração da negociação; só repassa se a etapa realmente mudou.
    const lastKey = `last-stage:${e.dealId}`;
    if ((await store.get(lastKey)) === e.stageId) {
      return { rule: 'R5', status: 'skipped', reason: 'etapa igual à última repassada', dealId: e.dealId };
    }

    if (config.stageFeedback.mode === 'field') {
      const field = config.stageFeedback.field;
      const value = config.stageNames[e.stageId] ?? e.stageId;
      const sig = echoSig.c2dField(clientId, field, value);
      await this.echo.markOwnWrite(sig);
      try {
        await chat2desk.setClientField(clientId, field, value);
      } catch (err) {
        await this.echo.unmark(sig);
        throw err;
      }
      await store.set(lastKey, e.stageId, LINK_TTL_MS);
      return { rule: 'R5', status: 'applied', dealId: e.dealId };
    }

    const tagId = config.stageFeedback.tagByStage[e.stageId];
    if (!tagId) return { rule: 'R5', status: 'skipped', reason: 'etapa sem etiqueta configurada', dealId: e.dealId };

    const prevKey = `stage-tag:${clientId}`;
    const prev = await store.get(prevKey);
    const sig = echoSig.c2dTag(clientId, tagId);
    await this.echo.markOwnWrite(sig);
    try {
      if (prev && prev !== tagId) await chat2desk.removeClientTag(clientId, prev);
      await chat2desk.addClientTag(clientId, tagId);
    } catch (err) {
      await this.echo.unmark(sig);
      throw err;
    }
    await store.set(prevKey, tagId, LINK_TTL_MS);
    await store.set(lastKey, e.stageId, LINK_TTL_MS);
    return { rule: 'R5', status: 'applied', dealId: e.dealId };
  }
}
