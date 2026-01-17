import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ExecModule = "telegram" | "feishu" | "notify" | "charts";

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  encoding?: BufferEncoding;
};

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

class Semaphore {
  private readonly max: number;
  private available: number;
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
    this.available = this.max;
  }

  acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const attempt = () => {
        if (this.available > 0) {
          this.available -= 1;
          this.inFlight += 1;
          resolve(() => {
            this.available += 1;
            this.inFlight -= 1;
            const next = this.queue.shift();
            if (next) next();
          });
          return;
        }
        this.queue.push(attempt);
      };
      attempt();
    });
  }

  state() {
    return {
      pending: this.queue.length,
      in_flight: this.inFlight,
      max: this.max,
    };
  }
}

const DEFAULT_LIMITS: Record<ExecModule, number> = {
  telegram: 4,
  feishu: 4,
  notify: 3,
  charts: 1,
};

type ExecMetrics = {
  count: number;
  totalWaitMs: number;
  maxWaitMs: number;
  maxQueue: number;
  lastQueue: number;
  buckets: [number, number, number, number];
  lastLogAt: number;
  sawContention: boolean;
};

function toLimit(value: any, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
}

function toNonNegativeInt(value: any, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function initMetrics(): ExecMetrics {
  return {
    count: 0,
    totalWaitMs: 0,
    maxWaitMs: 0,
    maxQueue: 0,
    lastQueue: 0,
    buckets: [0, 0, 0, 0],
    lastLogAt: Date.now(),
    sawContention: false,
  };
}

const globalLimit = toLimit(process.env.CHAT_GATEWAY_EXEC_MAX_GLOBAL, 8);
const globalSemaphore = new Semaphore(globalLimit);

const moduleSemaphores = new Map<ExecModule, Semaphore>();
const globalMetrics = initMetrics();
const moduleMetrics = new Map<ExecModule, ExecMetrics>();

const warnQueue = toNonNegativeInt(process.env.CHAT_GATEWAY_EXEC_WARN_QUEUE, 10);
const warnWaitMs = toNonNegativeInt(process.env.CHAT_GATEWAY_EXEC_WARN_WAIT_MS, 2000);
const logIntervalMs = toNonNegativeInt(process.env.CHAT_GATEWAY_EXEC_LOG_INTERVAL_MS, 60_000);
const defaultTimeoutMs = toNonNegativeInt(process.env.CHAT_GATEWAY_EXEC_TIMEOUT_MS, 60_000);
const moduleTimeouts: Record<ExecModule, number> = {
  telegram: toNonNegativeInt(process.env.CHAT_GATEWAY_EXEC_TIMEOUT_TELEGRAM_MS, defaultTimeoutMs),
  feishu: toNonNegativeInt(process.env.CHAT_GATEWAY_EXEC_TIMEOUT_FEISHU_MS, defaultTimeoutMs),
  notify: toNonNegativeInt(process.env.CHAT_GATEWAY_EXEC_TIMEOUT_NOTIFY_MS, defaultTimeoutMs),
  charts: toNonNegativeInt(process.env.CHAT_GATEWAY_EXEC_TIMEOUT_CHARTS_MS, defaultTimeoutMs),
};

function getModuleSemaphore(name: ExecModule): Semaphore {
  const cached = moduleSemaphores.get(name);
  if (cached) return cached;
  const envKey = `CHAT_GATEWAY_EXEC_MAX_${name.toUpperCase()}`;
  const limit = toLimit(process.env[envKey], DEFAULT_LIMITS[name] || 2);
  const sem = new Semaphore(limit);
  moduleSemaphores.set(name, sem);
  return sem;
}

function getModuleMetrics(name: ExecModule): ExecMetrics {
  const cached = moduleMetrics.get(name);
  if (cached) return cached;
  const m = initMetrics();
  moduleMetrics.set(name, m);
  return m;
}

function bucketIndex(waitMs: number): number {
  if (waitMs < 100) return 0;
  if (waitMs < 500) return 1;
  if (waitMs < 2000) return 2;
  return 3;
}

function recordMetrics(metrics: ExecMetrics, waitMs: number, queueLen: number) {
  metrics.count += 1;
  metrics.totalWaitMs += waitMs;
  metrics.maxWaitMs = Math.max(metrics.maxWaitMs, waitMs);
  metrics.maxQueue = Math.max(metrics.maxQueue, queueLen);
  metrics.lastQueue = queueLen;
  metrics.buckets[bucketIndex(waitMs)] += 1;
  if (waitMs > 0 || queueLen > 0) metrics.sawContention = true;
}

function maybeLogSummary(label: string, metrics: ExecMetrics) {
  if (logIntervalMs <= 0) return;
  const now = Date.now();
  if (now - metrics.lastLogAt < logIntervalMs) return;
  if (metrics.count && metrics.sawContention) {
    const avgWait = metrics.totalWaitMs / Math.max(1, metrics.count);
    console.warn(
      `[exec][STAT] ${label} count=${metrics.count} avg_wait_ms=${avgWait.toFixed(1)}` +
        ` max_wait_ms=${metrics.maxWaitMs} max_queue=${metrics.maxQueue} last_queue=${metrics.lastQueue}` +
        ` buckets=<100:${metrics.buckets[0]},<500:${metrics.buckets[1]},<2000:${metrics.buckets[2]},>=2000:${metrics.buckets[3]}`,
    );
  }
  metrics.count = 0;
  metrics.totalWaitMs = 0;
  metrics.maxWaitMs = 0;
  metrics.maxQueue = 0;
  metrics.lastQueue = 0;
  metrics.buckets = [0, 0, 0, 0];
  metrics.lastLogAt = now;
  metrics.sawContention = false;
}

export async function execFileLimited(
  moduleName: ExecModule,
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const moduleSemaphore = getModuleSemaphore(moduleName);
  const globalState = globalSemaphore.state();
  const moduleState = moduleSemaphore.state();

  const start = Date.now();
  const releaseGlobal = await globalSemaphore.acquire();
  const afterGlobal = Date.now();
  const releaseModule = await moduleSemaphore.acquire();
  const acquiredAt = Date.now();

  const waitGlobal = afterGlobal - start;
  const waitTotal = acquiredAt - start;
  const waitModule = waitTotal - waitGlobal;

  recordMetrics(globalMetrics, waitGlobal, globalState.pending);
  recordMetrics(getModuleMetrics(moduleName), waitTotal, moduleState.pending);

  const warnOnQueue = warnQueue > 0 && (moduleState.pending >= warnQueue || globalState.pending >= warnQueue);
  const warnOnWait = warnWaitMs > 0 && waitTotal >= warnWaitMs;
  if (warnOnQueue || warnOnWait) {
    console.warn(
      `[exec][WARN] module=${moduleName} wait_ms=${waitTotal} wait_global_ms=${waitGlobal}` +
        ` wait_module_ms=${waitModule} queue=${moduleState.pending} global_queue=${globalState.pending}` +
        ` in_flight=${moduleState.in_flight} global_in_flight=${globalState.in_flight}`,
    );
  }

  maybeLogSummary("global", globalMetrics);
  maybeLogSummary(moduleName, getModuleMetrics(moduleName));

  try {
    const timeout = options.timeout ?? moduleTimeouts[moduleName];
    const merged: ExecOptions = { ...options, encoding: "utf8", timeout };
    const res = await execFileAsync(file, args, merged);
    return { stdout: String(res.stdout || ""), stderr: String(res.stderr || "") };
  } finally {
    releaseModule();
    releaseGlobal();
  }
}
