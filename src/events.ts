/**
 * Eventos internos, já normalizados. Os parsers de webhook (adapters/*) convertem
 * o payload de cada ferramenta para estes formatos; as regras só conhecem estes tipos.
 */

export type Chat2DeskEvent =
  | { source: 'chat2desk'; type: 'message_in'; eventId: string; clientId: string; phone: string; name?: string }
  | { source: 'chat2desk'; type: 'tag_added'; eventId: string; clientId: string; phone: string; tagId: string }
  | {
      source: 'chat2desk';
      type: 'fields_changed';
      eventId: string;
      clientId: string;
      phone: string;
      fields: Record<string, string | null | undefined>;
    }
  | {
      source: 'chat2desk';
      type: 'dialog_closed';
      eventId: string;
      clientId: string;
      phone: string;
      dialogId: string;
      summary: string;
      channel: string;
      closedAt: string; // ISO
    };

export type CrmEvent = {
  source: 'rdcrm';
  type: 'deal_stage_changed';
  eventId: string;
  dealId: string;
  stageId: string;
};

export type IntegrationEvent = Chat2DeskEvent | CrmEvent;
