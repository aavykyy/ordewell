/**
 * Waits for runners' usage limits to reset (#84): one per runner, however
 * many tasks it paused, because a limit belongs to the account the runner
 * signs in with, not to one task. The tasks themselves, and the time each
 * resumes, stay on the plan; this only knows when to wake the orchestrator.
 */
export class UsageLimitWaits {
  private waits = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly onDue: (runner: string) => void) {}

  /**
   * Arm the runner's wait for `at`, or keep the later of it and the one
   * already armed: a runner is usable only once every limit it hit has reset.
   * Returns when the wait ends.
   */
  arm(runner: string, at: Date): Date {
    const current = this.waits.get(runner);
    if (current && current.at >= at.getTime()) return new Date(current.at);
    this.disarm(runner);
    this.schedule(runner, at.getTime());
    return at;
  }

  disarm(runner: string): void {
    const wait = this.waits.get(runner);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.waits.delete(runner);
  }

  clear(): void {
    for (const runner of [...this.waits.keys()]) this.disarm(runner);
  }

  armed(runner: string): boolean {
    return this.waits.has(runner);
  }

  private schedule(runner: string, at: number): void {
    // A timer cannot be set further out than this, so a longer wait re-arms itself.
    const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      if (this.waits.get(runner)?.timer !== timer) return;
      if (Date.now() < at) {
        this.schedule(runner, at);
        return;
      }
      this.waits.delete(runner);
      this.onDue(runner);
    }, delay);
    // A pending resume is no reason to keep a finished CLI process alive.
    timer.unref?.();
    this.waits.set(runner, { at, timer });
  }
}

const MAX_TIMER_MS = 2 ** 31 - 1;
