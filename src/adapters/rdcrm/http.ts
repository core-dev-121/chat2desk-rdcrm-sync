/**
 * Adaptador HTTP do RD Station CRM (API v1, autenticação por token).
 *
 * ATENÇÃO: os caminhos e o formato dos campos personalizados são confirmados no M1,
 * com a conta real (plano Pro). A lógica de negócio não depende deste arquivo:
 * ela está em rules.ts e é coberta pelos testes com o simulador em memória.
 */
import type { CrmContact, CrmDeal, CrmPort } from '../../ports.js';
import { HttpError, RateLimiter } from '../rateLimiter.js';

interface RdContact {
  id: string;
  _id?: string;
  name: string;
  phones?: { phone: string }[];
}

interface RdDeal {
  id: string;
  _id?: string;
  name: string;
  win?: boolean | null;
  closed_at?: string | null;
  deal_stage?: { id: string; _id?: string };
  contacts?: { id?: string; _id?: string }[];
}

export class RdCrmHttp implements CrmPort {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly opts: {
      token: string;
      baseUrl?: string;
      maxReqPerMin?: number;
      /** id do campo personalizado no RD para cada nome lógico usado no fieldMap */
      customFieldIds: Record<string, string>;
    },
  ) {
    this.limiter = new RateLimiter(opts.maxReqPerMin ?? 100);
  }

  private async call<T>(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
    await this.limiter.acquire();
    const url = new URL((this.opts.baseUrl ?? 'https://crm.rdstation.com/api/v1') + path);
    url.searchParams.set('token', this.opts.token);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, url.toString());
    return (text ? JSON.parse(text) : {}) as T;
  }

  private customFields(fields: Record<string, string>) {
    return Object.entries(fields).map(([name, value]) => {
      const id = this.opts.customFieldIds[name];
      if (!id) throw new Error(`Campo "${name}" sem id de campo personalizado no RD (configurar no M1)`);
      return { custom_field_id: id, value };
    });
  }

  private toContact(c: RdContact): CrmContact {
    return { id: c.id ?? c._id!, name: c.name, phones: (c.phones ?? []).map((p) => p.phone.replace(/\D/g, '')), fields: {} };
  }

  private toDeal(d: RdDeal): CrmDeal {
    return {
      id: d.id ?? d._id!,
      name: d.name,
      contactId: d.contacts?.[0]?.id ?? d.contacts?.[0]?._id ?? '',
      stageId: d.deal_stage?.id ?? d.deal_stage?._id ?? '',
      open: d.win === null || d.win === undefined ? !d.closed_at : false,
      fields: {},
    };
  }

  async findContactsByPhones(phones: string[]) {
    const byId = new Map<string, CrmContact>();
    for (const phone of phones) {
      const r = await this.call<{ contacts: RdContact[] }>('GET', '/contacts', undefined, { phone });
      for (const c of r.contacts ?? []) {
        const contact = this.toContact(c);
        // confere de novo localmente: a busca do RD pode ser por "contém"
        if (contact.phones.some((p) => phones.includes(p))) byId.set(contact.id, contact);
      }
    }
    return [...byId.values()];
  }

  async createContact({ name, phone }: { name: string; phone: string }) {
    const r = await this.call<RdContact>('POST', '/contacts', { contact: { name, phones: [{ phone, type: 'cellphone' }] } });
    return this.toContact(r);
  }

  async updateContactFields(contactId: string, fields: Record<string, string>) {
    await this.call('PUT', `/contacts/${contactId}`, { contact: { contact_custom_fields: this.customFields(fields) } });
  }

  async findOpenDeals(contactId: string) {
    const r = await this.call<{ deals: RdDeal[] }>('GET', '/deals', undefined, { contact_id: contactId, win: 'null' });
    return (r.deals ?? []).map((d) => this.toDeal(d)).filter((d) => d.open);
  }

  async getDeal(dealId: string) {
    try {
      return this.toDeal(await this.call<RdDeal>('GET', `/deals/${dealId}`));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async createDeal({ contactId, name, stageId }: { contactId: string; name: string; stageId: string }) {
    const r = await this.call<RdDeal>('POST', '/deals', {
      deal: { name, deal_stage_id: stageId },
      contacts: [{ _id: contactId }],
    });
    const deal = this.toDeal(r);
    return { ...deal, contactId: deal.contactId || contactId, stageId: deal.stageId || stageId };
  }

  async updateDealStage(dealId: string, stageId: string) {
    await this.call('PUT', `/deals/${dealId}`, { deal: { deal_stage_id: stageId } });
  }

  async updateDealFields(dealId: string, fields: Record<string, string>) {
    await this.call('PUT', `/deals/${dealId}`, { deal: { deal_custom_fields: this.customFields(fields) } });
  }

  async addDealNote(dealId: string, text: string) {
    await this.call('POST', '/activities', { activity: { deal_id: dealId, text } });
  }
}
