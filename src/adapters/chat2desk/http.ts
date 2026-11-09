/**
 * Adaptador HTTP do Chat2Desk (API v1, token no cabeçalho Authorization).
 *
 * ATENÇÃO: caminhos e formato confirmados no M1 com a conta real.
 * A lógica de negócio não depende deste arquivo (ver rules.ts e testes).
 */
import type { Chat2DeskPort } from '../../ports.js';
import { HttpError, RateLimiter } from '../rateLimiter.js';

export class Chat2DeskHttp implements Chat2DeskPort {
  private readonly limiter = new RateLimiter(200);

  constructor(
    private readonly opts: {
      token: string;
      baseUrl?: string;
      /** id do campo personalizado do Chat2Desk para cada nome lógico (ex.: "etapa_crm") */
      customFieldIds: Record<string, string>;
    },
  ) {}

  private async call(method: string, path: string, body?: unknown) {
    await this.limiter.acquire();
    const url = (this.opts.baseUrl ?? 'https://api.chat2desk.com/v1') + path;
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.opts.token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, url);
    return text ? JSON.parse(text) : {};
  }

  async setClientField(clientId: string, field: string, value: string) {
    const id = this.opts.customFieldIds[field];
    if (!id) throw new Error(`Campo "${field}" sem id no Chat2Desk (configurar no M1)`);
    await this.call('PUT', `/clients/${clientId}`, { custom_fields: { [id]: value } });
  }

  async addClientTag(clientId: string, tagId: string) {
    await this.call('POST', '/tags/assign_to', {
      tag_ids: [Number(tagId) || tagId],
      assignee_type: 'client',
      assignee_id: Number(clientId) || clientId,
    });
  }

  async removeClientTag(clientId: string, tagId: string) {
    await this.call('DELETE', `/clients/${clientId}/tags/${tagId}`);
  }
}
