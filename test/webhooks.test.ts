import { describe, expect, it } from 'vitest';
import { parseChat2DeskWebhook, parseRdCrmWebhook } from '../src/adapters/webhooks.js';

describe('parsers de webhook', () => {
  it('Chat2Desk: mensagem recebida', () => {
    const e = parseChat2DeskWebhook({ hook_type: 'inbox', message: { id: 991 }, client: { id: 5, phone: '5511988887777', name: 'Ana' } });
    expect(e).toMatchObject({ type: 'message_in', eventId: '991', clientId: '5', name: 'Ana' });
  });

  it('Chat2Desk: etiqueta aplicada', () => {
    const e = parseChat2DeskWebhook({ hook_type: 'add_tag_to_client', tag: { id: 12 }, client: { id: 5, phone: '5511988887777' } });
    expect(e).toMatchObject({ type: 'tag_added', tagId: '12' });
  });

  it('Chat2Desk: payload sem telefone não vira evento', () => {
    expect(parseChat2DeskWebhook({ hook_type: 'inbox', client: { id: 5 } })).toBeNull();
  });

  it('mesmo corpo reenviado gera o mesmo eventId', () => {
    const body = { hook_type: 'close_dialog', dialog_id: 3, summary: 'ok', client: { id: 5, phone: '11988887777' } };
    expect(parseChat2DeskWebhook(body)!.eventId).toBe(parseChat2DeskWebhook({ ...body })!.eventId);
  });

  it('RD CRM: negociação atualizada', () => {
    const e = parseRdCrmWebhook({ event_name: 'crm_deal_updated', document: { id: 'd1', deal_stage: { id: 's2' } } });
    expect(e).toMatchObject({ type: 'deal_stage_changed', dealId: 'd1', stageId: 's2' });
  });
});
