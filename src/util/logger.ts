type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const v = (process.env.FEDREG_LOG_LEVEL ?? 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as Level[]).includes(v as Level) ? (v as Level) : 'info';
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => write('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};

const RESERVED = new Set(['t', 'level', 'msg', 'message', 'timestamp']);

function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < order[envLevel()]) return;
  const fields: Record<string, unknown> = {};
  // Extras never overwrite the envelope. `message`/`timestamp` are reserved too: log
  // platforms (Railway) map `msg` onto `message`, which would silently drop an extra `message`.
  for (const [k, v] of Object.entries(extra ?? {})) fields[RESERVED.has(k) ? `extra_${k}` : k] = v;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  // stdio transport reserves stdout for JSON-RPC; log to stderr.
  process.stderr.write(line + '\n');
}
