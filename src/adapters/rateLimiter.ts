/**
 * Limitador simples (janela deslizante) para respeitar o limite de requisições da API,
 * inclusive em picos (ex.: muitos atendimentos encerrando no fim do expediente).
 */
export class RateLimiter {
  private stamps: number[] = [];

  constructor(private readonly maxPerWindow: number, private readonly windowMs = 60_000) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.maxPerWindow) {
        this.stamps.push(now);
        return;
      }
      const wait = this.windowMs - (now - this.stamps[0]!) + 5;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: string, public readonly url: string) {
    super(`HTTP ${status} em ${url.replace(/token=[^&]+/, 'token=***')}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}
