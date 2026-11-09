/**
 * Serializa o processamento por chave (telefone). Evita a corrida clássica de R1:
 * duas mensagens do mesmo número chegando juntas e criando dois contatos.
 *
 * Com várias instâncias do worker, trocar por lock no Redis ou particionar a fila
 * por telefone (ex.: BullMQ groups). Com uma instância, isto basta.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
