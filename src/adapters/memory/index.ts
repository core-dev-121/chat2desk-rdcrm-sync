/**
 * Simuladores em memória do RD Station CRM e do Chat2Desk.
 *
 * Eles se comportam como as ferramentas reais num ponto que importa para o eco:
 * toda escrita dispara o webhook correspondente (onWebhook), inclusive as feitas
 * pela própria integração. Assim os testes provam que o eco é bloqueado de ponta a ponta.
 */
import { randomUUID } from 'node:crypto';
import type { IntegrationEvent } from '../../events.js';
import type { Chat2DeskPort, CrmContact, CrmDeal, CrmPort } from '../../ports.js';

type WebhookSink = (e: IntegrationEvent) => void | Promise<void>;

export class InMemoryCrm implements CrmPort {
  contacts = new Map<string, CrmContact>();
  deals = new Map<string, CrmDeal>();
  notes: { dealId: string; text: string }[] = [];
  calls = { createContact: 0, createDeal: 0, updateDealStage: 0 };
  /** Para simular instabilidade: quantas próximas chamadas de escrita falham. */
  failNextWrites = 0;
  private seq = 0;

  constructor(public onWebhook?: WebhookSink) {}

  private maybeFail() {
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      throw new Error('RD CRM: 503 Service Unavailable (simulado)');
    }
  }

  async findContactsByPhones(phones: string[]) {
    return [...this.contacts.values()].filter((c) => c.phones.some((p) => phones.includes(p)));
  }

  async createContact({ name, phone }: { name: string; phone: string }) {
    this.maybeFail();
    this.calls.createContact++;
    const c: CrmContact = { id: `contact-${++this.seq}`, name, phones: [phone], fields: {} };
    this.contacts.set(c.id, c);
    return c;
  }

  async updateContactFields(contactId: string, fields: Record<string, string>) {
    this.maybeFail();
    Object.assign(this.contacts.get(contactId)!.fields, fields);
  }

  async findOpenDeals(contactId: string) {
    return [...this.deals.values()].filter((d) => d.contactId === contactId && d.open);
  }

  async getDeal(dealId: string) {
    return this.deals.get(dealId) ?? null;
  }

  async createDeal({ contactId, name, stageId }: { contactId: string; name: string; stageId: string }) {
    this.maybeFail();
    this.calls.createDeal++;
    const d: CrmDeal = { id: `deal-${++this.seq}`, name, contactId, stageId, open: true, fields: {} };
    this.deals.set(d.id, d);
    return d;
  }

  async updateDealStage(dealId: string, stageId: string) {
    this.maybeFail();
    this.calls.updateDealStage++;
    this.deals.get(dealId)!.stageId = stageId;
    await this.onWebhook?.({ source: 'rdcrm', type: 'deal_stage_changed', eventId: randomUUID(), dealId, stageId });
  }

  async updateDealFields(dealId: string, fields: Record<string, string>) {
    this.maybeFail();
    Object.assign(this.deals.get(dealId)!.fields, fields);
  }

  async addDealNote(dealId: string, text: string) {
    this.maybeFail();
    this.notes.push({ dealId, text });
  }

  /** Simula um consultor mudando a etapa direto no CRM. */
  async consultantMovesDeal(dealId: string, stageId: string) {
    this.deals.get(dealId)!.stageId = stageId;
    await this.onWebhook?.({ source: 'rdcrm', type: 'deal_stage_changed', eventId: randomUUID(), dealId, stageId });
  }

  /** Semeia um contato antigo, como os ~58 mil já existentes (às vezes sem DDI ou sem o 9). */
  seedContact(name: string, storedPhone: string): CrmContact {
    const c: CrmContact = { id: `contact-${++this.seq}`, name, phones: [storedPhone], fields: {} };
    this.contacts.set(c.id, c);
    return c;
  }
}

export class InMemoryChat2Desk implements Chat2DeskPort {
  clients = new Map<string, { phone: string; tags: Set<string>; fields: Record<string, string> }>();

  constructor(public onWebhook?: WebhookSink) {}

  private client(id: string) {
    let c = this.clients.get(id);
    if (!c) {
      c = { phone: '', tags: new Set(), fields: {} };
      this.clients.set(id, c);
    }
    return c;
  }

  register(clientId: string, phone: string) {
    this.client(clientId).phone = phone;
  }

  async setClientField(clientId: string, field: string, value: string) {
    const c = this.client(clientId);
    c.fields[field] = value;
    await this.onWebhook?.({
      source: 'chat2desk',
      type: 'fields_changed',
      eventId: randomUUID(),
      clientId,
      phone: c.phone,
      fields: { [field]: value },
    });
  }

  async addClientTag(clientId: string, tagId: string) {
    const c = this.client(clientId);
    c.tags.add(tagId);
    await this.onWebhook?.({ source: 'chat2desk', type: 'tag_added', eventId: randomUUID(), clientId, phone: c.phone, tagId });
  }

  async removeClientTag(clientId: string, tagId: string) {
    this.client(clientId).tags.delete(tagId);
  }
}
