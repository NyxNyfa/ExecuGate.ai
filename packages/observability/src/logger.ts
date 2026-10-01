import { redact } from './redact.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

function emit(level: Level, scope: string, msg: string, data?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: redact(msg) as string,
    ...(data ? (redact(data) as Record<string, unknown>) : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => emit('debug', scope, m, d),
    info: (m, d) => emit('info', scope, m, d),
    warn: (m, d) => emit('warn', scope, m, d),
    error: (m, d) => emit('error', scope, m, d),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Simple wall-clock timer; every provider path reports its own latency (NFR §8.1). */
export function startTimer(): () => number {
  const t0 = performance.now();
  return () => Math.round(performance.now() - t0);
}
