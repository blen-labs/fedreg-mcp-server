import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const PATH = process.env.PATH ?? '';
const bin = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/bin.ts', ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    input: '',
    env: { PATH, ...env },
  });

/** The process refused to start: exit 1 and the message names the problem, with nothing on stdout. */
function expectRefusal(r: ReturnType<typeof bin>, message: string): void {
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(message);
  expect(r.stdout).toBe('');
}

describe('command line', () => {
  // A mistyped --http would otherwise start the stdio transport and wait on stdin without a word.
  it('refuses an option it does not know', () => {
    expectRefusal(bin(['--htpp', '--insecure']), "Unknown option '--htpp'");
  });

  it('prints help and exits 0', () => {
    const r = bin(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--sandbox auto|isolate|deno');
    // `pnpm dev -- --help` hands the separator on.
    expect(bin(['--', '--help']).status).toBe(0);
  });

  it('refuses an unknown sandbox, from the flag or the environment', () => {
    expectRefusal(bin(['--sandbox', 'docker']), "Unknown sandbox 'docker'");
    expectRefusal(bin([], { FEDREG_SANDBOX: 'docker' }), "Unknown sandbox 'docker'");
  });

  it('refuses an option that is missing its value', () => {
    expectRefusal(bin(['--http', '--port']), "Option '--port' needs a value");
    expectRefusal(bin(['--sandbox']), "Option '--sandbox' needs a value");
    expectRefusal(bin(['--host']), "Option '--host' needs a value");
  });

  it('refuses a port that is not a port', () => {
    expectRefusal(bin(['--port', 'abc']), "--port must be a number, got 'abc'");
    expectRefusal(bin(['--port', '70000']), '--port must be a whole number from 0 to 65535');
    expectRefusal(bin([], { PORT: '' }), 'PORT is blank');
    expectRefusal(bin([], { PORT: '80.5' }), 'PORT must be a whole number');
  });

  it('refuses blank or non-numeric numeric settings instead of reading them as 0', () => {
    for (const name of ['FEDREG_UPSTREAM_TIMEOUT_MS', 'FEDREG_UPSTREAM_RETRIES', 'FEDREG_CACHE_TTL_MS', 'FEDREG_CACHE_MAX_ITEMS', 'FEDREG_REGS_MAX_CALLS_PER_EXECUTE', 'FEDREG_SUBJECT_DAILY_QUOTA']) {
      expectRefusal(bin(['--http', '--insecure'], { [name]: '' }), `${name} is blank`);
      expectRefusal(bin(['--http', '--insecure'], { [name]: 'lots' }), `${name} must be a number, got 'lots'`);
    }
  });

  // An MCPB host passes '${user_config.x}' literally for a field the user left empty.
  it('refuses an unexpanded MCPB placeholder where a real value is needed', () => {
    /* eslint-disable no-template-curly-in-string */
    const placeholder = '${user_config.port}';
    expectRefusal(bin(['--port', placeholder]), "--port is the unexpanded placeholder '${user_config.port}'");
    expectRefusal(bin([], { PORT: placeholder }), 'PORT is the unexpanded placeholder');
    expectRefusal(bin([], { HOST: placeholder }), 'HOST is the unexpanded placeholder');
    expectRefusal(bin(['--sandbox', placeholder]), '--sandbox is the unexpanded placeholder');
    expectRefusal(bin([], { FEDREG_CACHE_TTL_MS: placeholder }), 'FEDREG_CACHE_TTL_MS is the unexpanded placeholder');
    /* eslint-enable no-template-curly-in-string */
  });

  // The bundle's manifest sets FEDREG_REGS_API_KEY to the placeholder when the optional key is empty:
  // that must start the server (regs.* stays disabled), not stop it.
  it('starts when the optional regulations.gov key is an unexpanded placeholder', () => {
    // eslint-disable-next-line no-template-curly-in-string
    const r = bin([], { FEDREG_REGS_API_KEY: '${user_config.regs_api_key}', FEDREG_SANDBOX: 'auto' });
    expect(r.status).toBe(0);
    expect(r.stderr + r.stdout).toContain('stdio.ready');
  });
});
