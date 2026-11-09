/**
 * Conversão do payload bruto de cada webhook para os eventos internos.
 *
 * Os nomes de campo do payload são lidos de forma defensiva (várias grafias possíveis)
 * e o mapeamento definitivo é fechado no M1, com payloads reais capturados no ambiente de teste.
 * Payload que não é reconhecido não é descartado em silêncio: o servidor registra e responde 202.
 */
import { createHash } from 'node:crypto';
import type { Chat2DeskEvent, CrmEvent } from '../events.js';

type Json = Record<string, any>;

function pick<T = string>(obj: Json | undefined, ...paths: string[]): T | undefined {
  for (const p of paths) {
    const v = p.split('.').reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v as T;
  }
  return undefined;
}

/** Id estável do evento: usa o id enviado pela ferramenta ou o hash do corpo (reenvio = mesmo id). */
function eventIdOf(body: Json): string {
  const explicit = pick(body, 'event_id', 'id', 'message.id', 'request_id');
  return explicit ? String(explicit) : createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
}

export function parseChat2DeskWebhook(body: Json): Chat2DeskEvent | null {
  const hook = String(pick(body, 'hook_type', 'event', 'type') ?? '');
  const clientId = String(pick(body, 'client.id', 'client_id') ?? '');
  const phone = String(pick(body, 'client.phone', 'phone', 'client.client_phone') ?? '');
  const eventId = eventIdOf(body);
  if (!clientId || !phone) return null;

  if (['inbox', 'new_message', 'message_in'].includes(hook)) {
    return { source: 'chat2desk', type: 'message_in', eventId, clientId, phone, name: pick(body, 'client.name', 'client.username') };
  }
  if (['add_tag_to_client', 'tag_added', 'client_tag_added'].includes(hook)) {
    const tagId = pick(body, 'tag.id', 'tag_id');
    return tagId ? { source: 'chat2desk', type: 'tag_added', eventId, clientId, phone, tagId: String(tagId) } : null;
  }
  if (['client_updated', 'custom_fields_changed', 'fields_changed'].includes(hook)) {
    const fields = pick<Json>(body, 'custom_fields', 'client.custom_fields') ?? {};
    return { source: 'chat2desk', type: 'fields_changed', eventId, clientId, phone, fields };
  }
  if (['close_dialog', 'dialog_closed', 'request_closed'].includes(hook)) {
    return {
      source: 'chat2desk',
      type: 'dialog_closed',
      eventId,
      clientId,
      phone,
      dialogId: String(pick(body, 'dialog_id', 'dialog.id', 'request_id') ?? eventId),
      summary: String(pick(body, 'summary', 'custom_fields.resumo', 'client.custom_fields.resumo') ?? ''),
      channel: String(pick(body, 'channel.name', 'transport', 'channel') ?? 'WhatsApp'),
      closedAt: String(pick(body, 'closed_at', 'created') ?? new Date().toISOString()),
    };
  }
  return null;
}

export function parseRdCrmWebhook(body: Json): CrmEvent | null {
  const name = String(pick(body, 'event_name', 'event') ?? '');
  if (!/deal/.test(name)) return null;
  const dealId = pick(body, 'document.id', 'document._id', 'deal.id');
  const stageId = pick(body, 'document.deal_stage.id', 'document.deal_stage._id', 'deal.deal_stage_id');
  if (!dealId || !stageId) return null;
  return { source: 'rdcrm', type: 'deal_stage_changed', eventId: eventIdOf(body), dealId: String(dealId), stageId: String(stageId) };
}
