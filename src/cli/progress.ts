/** Human terminal feedback only. Callers supply fixed labels, never private input. */
export class TerminalProgress {
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly write: (line: string) => void, private readonly enabled = true) {}

  start(label: string): void {
    this.stop();
    if (!this.enabled) return;
    this.write(label);
    const started = Date.now();
    this.timer = setInterval(() => {
      this.write(`  Still working (${Math.floor((Date.now() - started) / 1000)}s). ${label}`);
    }, 10_000);
    this.timer.unref();
  }

  /** Stop before any input prompt, on completion, and on every error path. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
