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

function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < order[envLevel()]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra ?? {}) });
  // stdio transport reserves stdout for JSON-RPC; log to stderr.
  process.stderr.write(line + '\n');
}
