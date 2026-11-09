/**
 * Contratos com as ferramentas externas. As regras dependem só destas interfaces:
 * em produção entram os adaptadores HTTP; nos testes e na demo, os adaptadores em memória.
 */

export interface CrmContact {
  id: string;
  name: string;
  phones: string[];
  fields: Record<string, string>;
}

export interface CrmDeal {
  id: string;
  name: string;
  contactId: string;
  stageId: string;
  open: boolean;
  fields: Record<string, string>;
}

export interface CrmPort {
  /** Busca contatos que tenham qualquer uma das variações de telefone. */
  findContactsByPhones(phones: string[]): Promise<CrmContact[]>;
  createContact(input: { name: string; phone: string }): Promise<CrmContact>;
  updateContactFields(contactId: string, fields: Record<string, string>): Promise<void>;

  findOpenDeals(contactId: string): Promise<CrmDeal[]>;
  getDeal(dealId: string): Promise<CrmDeal | null>;
  createDeal(input: { contactId: string; name: string; stageId: string }): Promise<CrmDeal>;
  updateDealStage(dealId: string, stageId: string): Promise<void>;
  updateDealFields(dealId: string, fields: Record<string, string>): Promise<void>;
  addDealNote(dealId: string, text: string): Promise<void>;
}

export interface Chat2DeskPort {
  setClientField(clientId: string, field: string, value: string): Promise<void>;
  addClientTag(clientId: string, tagId: string): Promise<void>;
  removeClientTag(clientId: string, tagId: string): Promise<void>;
}
