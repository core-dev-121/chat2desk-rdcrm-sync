/**
 * Demonstração ponta a ponta, sem credenciais: `npm run demo`
 * Roda as seis regras contra os simuladores e imprime o que a integração decidiu em cada evento.
 */
import { buildHarness } from './harness.js';

const h = buildHarness();
const CLIENT = 'c2d-1001';
let printed = 0;

async function step(title: string, action: () => Promise<unknown>) {
  console.log(`\n▶ ${title}`);
  await action();
  await h.queue.idle();
  for (const o of h.outcomes.slice(printed)) {
    const mark = o.status === 'applied' ? '✔' : '·';
    console.log(`   ${mark} ${o.rule} [${o.event}] ${o.status}${o.reason ? ` — ${o.reason}` : ''}`);
  }
  printed = h.outcomes.length;
}

const deal = () => [...h.crm.deals.values()][0]!;

await step('Cadastro antigo no CRM gravado como "1188887777" (sem DDI e sem o 9)', async () => {
  h.crm.seedContact('Maria Souza', '1188887777');
});
await step('Maria chama direto no WhatsApp como "+55 11 98888-7777" (R1/R6)', () =>
  h.c2d.message(CLIENT, '+55 11 98888-7777', 'Maria'),
);
await step('Duas mensagens chegam ao mesmo tempo (R1)', () =>
  Promise.all([h.c2d.message(CLIENT, '+55 11 98888-7777'), h.c2d.message(CLIENT, '551188887777')]),
);
await step('Consultor preenche destino e nº de pessoas (R3)', () =>
  h.c2d.fields(CLIENT, '5511988887777', { destino: 'Lisboa', num_pessoas: '4' }),
);
await step('Campo destino é apagado no Chat2Desk (R3: não apaga no CRM)', () =>
  h.c2d.fields(CLIENT, '5511988887777', { destino: '' }),
);
await step('Etiqueta de prioridade aplicada (R2) — o webhook de volta do CRM deve ser eco', () =>
  h.c2d.tag(CLIENT, '5511988887777', h.config.priorityTagId),
);
await step('Etiqueta de prioridade aplicada de novo (R2: não move de novo)', () =>
  h.c2d.tag(CLIENT, '5511988887777', h.config.priorityTagId),
);
await step('Consultor move para "Proposta enviada" no CRM (R5) — o campo gravado no Chat2Desk deve ser eco', () =>
  h.crm.consultantMovesDeal(deal().id, 'stage-proposta'),
);
await step('Atendimento encerrado; o webhook chega duplicado (R4)', async () => {
  await h.c2d.close(CLIENT, '5511988887777', 'dlg-1', 'Pacote Lisboa, maio, 4 pessoas, hotel 4*.');
  await h.c2d.close(CLIENT, '5511988887777', 'dlg-1', 'Pacote Lisboa, maio, 4 pessoas, hotel 4*.');
});
await step('RD CRM instável (2 falhas seguidas) quando chega um contato novo', async () => {
  h.crm.failNextWrites = 2;
  await h.c2d.message('c2d-2002', '(21) 99999-0000', 'João');
});

console.log('\n── Estado final ─────────────────────────────');
console.log('Contatos no CRM:', h.crm.contacts.size, '· Negociações:', h.crm.deals.size, '· Notas:', h.crm.notes.length);
console.log('Negociação da Maria:', { etapa: deal().stageId, campos: deal().fields });
console.log('Campo "etapa_crm" no Chat2Desk:', h.chat2desk.clients.get(CLIENT)?.fields.etapa_crm);
console.log('Fila:', h.queue.getStats(), '· Alertas:', h.alerts.length);
