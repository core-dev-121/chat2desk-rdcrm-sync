/**
 * Servidor de webhooks.
 *   POST /webhooks/chat2desk?secret=...   eventos do Chat2Desk
 *   POST /webhooks/rdcrm?secret=...       eventos do RD Station CRM
 *   GET  /health                          painel de saúde: recebidos, processados, em nova tentativa, falhas
 *   POST /admin/replay?secret=...         reprocessa a fila de falhas depois de corrigida a causa
 *
 * O webhook só valida, enfileira e responde. O processamento é assíncrono na fila.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Chat2DeskHttp } from './adapters/chat2desk/http.js';
import { RdCrmHttp } from './adapters/rdcrm/http.js';
import { parseChat2DeskWebhook, parseRdCrmWebhook } from './adapters/webhooks.js';
import { loadConfig } from './config.js';
import { EventQueue, type FailedEvent } from './queue.js';
import { consoleLogger, IntegrationRules } from './rules.js';
import { MemoryStore, type KeyValueStore } from './store.js';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

async function makeStore(): Promise<KeyValueStore> {
  const url = process.env.REDIS_URL;
  if (!url) {
    consoleLogger.warn('REDIS_URL não definido: usando memória (somente para teste local)');
    return new MemoryStore();
  }
  const mod: any = await import('ioredis');
  const Redis = mod.Redis ?? mod.default;
  const { RedisStore } = await import('./store.js');
  return new RedisStore(new Redis(url));
}

async function alertTeam(f: FailedEvent) {
  consoleLogger.warn('Evento na fila de falhas', { ...f });
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const text =
    `⚠️ Integração Chat2Desk ↔ RD CRM: evento falhou ${f.attempts}x e foi para a fila de falhas.\n` +
    `Tipo: ${f.event.source}/${f.event.type} · Erro: ${f.lastError}`;
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).catch(
    (e) => consoleLogger.warn('Falha ao enviar alerta', { error: String(e) }),
  );
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function main() {
  const config = loadConfig(env('CONFIG_PATH', 'config/integration.example.json'));
  const secret = env('WEBHOOK_SECRET');
  const store = await makeStore();

  const rules = new IntegrationRules({
    crm: new RdCrmHttp({
      token: env('RD_CRM_TOKEN'),
      baseUrl: process.env.RD_CRM_BASE_URL,
      maxReqPerMin: Number(process.env.RD_CRM_MAX_REQ_PER_MIN ?? 100),
      customFieldIds: JSON.parse(process.env.RD_CRM_CUSTOM_FIELD_IDS ?? '{}'),
    }),
    chat2desk: new Chat2DeskHttp({
      token: env('CHAT2DESK_TOKEN'),
      baseUrl: process.env.CHAT2DESK_BASE_URL,
      customFieldIds: JSON.parse(process.env.CHAT2DESK_CUSTOM_FIELD_IDS ?? '{}'),
    }),
    store,
    config,
  });

  const queue = new EventQueue({
    store,
    handler: async (e) => consoleLogger.info('regra', { event: e.type, ...(await rules.handle(e)) }),
    onDeadLetter: alertTeam,
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, queue.getStats());

      if (url.searchParams.get('secret') !== secret) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'POST' && url.pathname === '/admin/replay') {
        return send(res, 200, { replayed: queue.replayDeadLetters() });
      }
      if (req.method === 'POST' && (url.pathname === '/webhooks/chat2desk' || url.pathname === '/webhooks/rdcrm')) {
        const body = await readJson(req);
        const event = url.pathname.endsWith('chat2desk') ? parseChat2DeskWebhook(body) : parseRdCrmWebhook(body);
        if (!event) {
          consoleLogger.warn('Webhook não reconhecido (registrado, sem ação)', { path: url.pathname, body });
          return send(res, 202, { ignored: true });
        }
        const fresh = await queue.enqueue(event);
        return send(res, 200, { queued: fresh, duplicate: !fresh });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      consoleLogger.warn('Erro no recebimento do webhook', { error: String(err) });
      return send(res, 500, { error: 'internal' }); // a ferramenta reenvia
    }
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => consoleLogger.info(`Ouvindo na porta ${port}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
