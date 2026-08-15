// pacing.ts — N6: human-pacing. Случайная задержка min..max мс перед каждым
// act.* и лимит max_actions_per_minute (скользящее окно) → PACING_LIMIT.
export class PacingLimitError extends Error {
  code = 'PACING_LIMIT';
  constructor(limit: number) {
    super(`превышен лимит ${limit} действий/мин`);
  }
}

export class Pacing {
  private timestamps: number[] = [];
  private getConfig: () => { min_delay_ms: number; max_delay_ms: number; max_actions_per_minute: number };
  private sleepFn: (ms: number) => Promise<void>;

  constructor(
    getConfig: () => { min_delay_ms: number; max_delay_ms: number; max_actions_per_minute: number },
    sleepFn?: (ms: number) => Promise<void>,
  ) {
    this.getConfig = getConfig;
    this.sleepFn = sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Вызывать перед каждым act.*. Бросает PacingLimitError при превышении лимита. */
  async beforeAction(delay?: { min_ms: number; max_ms: number }): Promise<void> {
    const cfg = this.getConfig();
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length >= cfg.max_actions_per_minute) {
      throw new PacingLimitError(cfg.max_actions_per_minute);
    }
    const lo = Math.max(0, Math.min(delay?.min_ms ?? cfg.min_delay_ms, delay?.max_ms ?? cfg.max_delay_ms));
    const hi = Math.max(lo, delay?.max_ms ?? cfg.max_delay_ms);
    const wait = lo + Math.floor(Math.random() * (hi - lo + 1));
    if (wait > 0) await this.sleepFn(wait);
    this.timestamps.push(Date.now());
  }

  /**
   * П1-2: проверка, что в скользящее окно влезут ещё n действий, БЕЗ задержки
   * и без записи. act.batch зовёт это до начала пакета, чтобы отклонить его
   * целиком, а не упасть лимитом посередине (partial execution).
   */
  checkCapacity(n: number): void {
    const cfg = this.getConfig();
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length + n > cfg.max_actions_per_minute) {
      throw new PacingLimitError(cfg.max_actions_per_minute);
    }
  }
}
