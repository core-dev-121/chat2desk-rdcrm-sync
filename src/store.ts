/**
 * Armazenamento chave-valor com TTL. Base de três mecanismos:
 * idempotência, bloqueio de eco e vínculo negociação ↔ cliente do Chat2Desk.
 *
 * Em produção: RedisStore (SET NX PX é atômico, funciona com várias instâncias).
 * Em testes e na demo: MemoryStore.
 */
export interface KeyValueStore {
  /** Grava só se a chave não existir. Retorna true se gravou. */
  setIfAbsent(key: string, value: string, ttlMs?: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Lê e apaga numa operação (usado para consumir a marca de eco). */
  take(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  private data = new Map<string, { value: string; expiresAt: number | null }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  async setIfAbsent(key: string, value: string, ttlMs?: number) {
    if (this.live(key)) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs?: number) {
    this.data.set(key, { value, expiresAt: ttlMs ? this.now() + ttlMs : null });
  }

  async take(key: string) {
    const v = this.live(key)?.value ?? null;
    this.data.delete(key);
    return v;
  }

  async del(key: string) {
    this.data.delete(key);
  }
}

/** Interface mínima do cliente Redis (compatível com ioredis), para não acoplar a lib. */
export interface RedisLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export class RedisStore implements KeyValueStore {
  constructor(private readonly redis: RedisLike, private readonly prefix = 'c2d-rd:') {}

  async setIfAbsent(key: string, value: string, ttlMs?: number) {
    const args: (string | number)[] = ttlMs ? ['PX', ttlMs, 'NX'] : ['NX'];
    return (await this.redis.set(this.prefix + key, value, ...args)) === 'OK';
  }
  async get(key: string) {
    return this.redis.get(this.prefix + key);
  }
  async set(key: string, value: string, ttlMs?: number) {
    if (ttlMs) await this.redis.set(this.prefix + key, value, 'PX', ttlMs);
    else await this.redis.set(this.prefix + key, value);
  }
  async take(key: string) {
    return this.redis.getdel(this.prefix + key);
  }
  async del(key: string) {
    await this.redis.del(this.prefix + key);
  }
}
