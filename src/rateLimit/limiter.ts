export class RateLimiter {
  private perUser: Map<string, number[]> = new Map();
  private global: number[] = [];

  constructor(private perUserPerMin: number, private globalPerMin: number) {}

  allow(userId: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;

    const g = this.global.filter(t => t >= cutoff);
    if (g.length >= this.globalPerMin) return false;
    g.push(now);
    this.global = g;

    const arr = (this.perUser.get(userId) ?? []).filter(t => t >= cutoff);
    if (arr.length >= this.perUserPerMin) return false;
    arr.push(now);
    this.perUser.set(userId, arr);
    return true;
  }
}
