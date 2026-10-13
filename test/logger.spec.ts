import { describe, it, expect } from 'vitest';
import { log } from '../src/util/logger.js';

describe('logger', () => {
  it('never lets extras overwrite the envelope or the platform message field', () => {
    const lines: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => { lines.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      log.warn('mcp.handler.error', { message: 'boom', msg: 'spoof', level: 'debug', status: 429 });
    } finally {
      process.stderr.write = write;
    }
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 'warn', msg: 'mcp.handler.error', status: 429, extra_message: 'boom', extra_msg: 'spoof', extra_level: 'debug' });
    expect(entry).not.toHaveProperty('message');
  });
});
