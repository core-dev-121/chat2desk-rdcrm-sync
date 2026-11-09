import { readFileSync } from 'node:fs';

export type FieldTarget = 'contact' | 'deal' | 'both';

export interface IntegrationConfig {
  /** Etapa inicial do funil para negociações criadas pela integração (R1). */
  initialStageId: string;
  /** Etiqueta de prioridade no Chat2Desk e a etapa para onde ela leva (R2). */
  priorityTagId: string;
  priorityStageId: string;
  /** Etiquetas de outros fluxos (ex.: as duas do n8n). Nunca disparam regra. */
  ignoredTagIds: string[];
  /** Campo personalizado do Chat2Desk -> campo no CRM (R3). Lista fechada no M1. */
  fieldMap: Record<string, { target: FieldTarget; crmField: string }>;
  /**
   * Como a etapa do CRM volta para o Chat2Desk (R5):
   *  - "field": grava o nome da etapa num campo próprio (recomendado: não colide com a etiqueta de prioridade);
   *  - "tag": aplica uma etiqueta por etapa (remove a da etapa anterior).
   */
  stageFeedback:
    | { mode: 'field'; field: string }
    | { mode: 'tag'; tagByStage: Record<string, string> };
  stageNames: Record<string, string>;
  dealNamePrefix: string;
  echoTtlMs: number;
}

export function loadConfig(path: string): IntegrationConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as IntegrationConfig;
  if (cfg.ignoredTagIds.includes(cfg.priorityTagId)) {
    throw new Error('priorityTagId não pode estar em ignoredTagIds');
  }
  return cfg;
}

export const demoConfig: IntegrationConfig = {
  initialStageId: 'stage-novo',
  priorityTagId: 'tag-prioridade',
  priorityStageId: 'stage-2',
  ignoredTagIds: ['tag-n8n-conversao', 'tag-n8n-rdmkt'],
  fieldMap: {
    destino: { target: 'both', crmField: 'destino' },
    data_ida: { target: 'deal', crmField: 'data_ida' },
    data_volta: { target: 'deal', crmField: 'data_volta' },
    num_pessoas: { target: 'deal', crmField: 'num_pessoas' },
  },
  stageFeedback: { mode: 'field', field: 'etapa_crm' },
  stageNames: {
    'stage-novo': 'Novo contato',
    'stage-2': 'Prioridade',
    'stage-proposta': 'Proposta enviada',
    'stage-fechado': 'Fechado',
  },
  dealNamePrefix: 'WhatsApp',
  echoTtlMs: 10 * 60_000,
};
