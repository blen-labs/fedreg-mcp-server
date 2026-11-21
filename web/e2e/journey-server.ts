// A real account-mode server for the browser journey (web/e2e/journey.spec.ts): the actual
// Express app, Better Auth, PostgreSQL (TEST_DATABASE_URL), the Deno sandbox and the built
// portal (dist/web). Only the outside world is replaced: Google sign-in by Better Auth's test
// session for one user, regulations.gov key checks by a fetcher that accepts any key, and
// regulations.gov API calls by an undici MockAgent. It writes the signed-in user's session cookies to JOURNEY_STATE so the
// browser starts signed in, as it would after Google.
//
//   TEST_DATABASE_URL=postgres://… pnpm exec tsx web/e2e/journey-server.ts   (port 4175)
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { testUtils } from 'better-auth/plugins';
import { MockAgent } from 'undici';
import { Keyring, randomToken } from '../../src/accounts/crypto.js';
import { Store } from '../../src/accounts/store.js';
import { createAccountApp } from '../../src/accounts/app.js';
import { accountDependencies, publicDependencies } from '../../src/accounts/runtime.js';
import type { AccountConfig } from '../../src/accounts/config.js';
import { buildSupervisor, type SupervisorConfig } from '../../src/supervisor/index.js';

const PORT = 4175;
const database = process.env.TEST_DATABASE_URL;
const statePath = process.env.JOURNEY_STATE;
if (!database) throw new Error('TEST_DATABASE_URL is required for the browser journey');
if (!statePath) throw new Error('JOURNEY_STATE (set by playwright.config.ts) is required for the browser journey');

const schema = `fedreg_journey_${randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: database });
await admin.query(`CREATE SCHEMA ${schema}`);
await admin.end();
const pool = new Pool({ connectionString: database, options: `-c search_path=${schema}` });
const store = new Store(pool, new Keyring('v1', { v1: randomBytes(32) }));
await store.initialize();

const origin = `http://127.0.0.1:${PORT}`;
const config: AccountConfig = {
  origin, production: false, databaseUrl: database, authSecret: randomToken(),
  googleClientId: 'journey-google', googleClientSecret: 'journey-secret', keyring: new Keyring('v1', { v1: randomBytes(32) }),
};
const cfg: SupervisorConfig = {
  frBaseUrl: 'https://www.federalregister.gov/api/v1', ecfrBaseUrl: 'https://www.ecfr.gov/api',
  regsBaseUrl: 'https://api.regulations.gov', userAgent: 'journey',
  upstreamTimeoutMs: 5000, upstreamRetries: 0, cacheTtlMs: 60000, cacheMaxItems: 10,
  sandbox: 'deno', regsMaxCallsPerExecute: 30, regsRatePerHour: 1000, regsSubjectRatePerHour: 500,
};
const deps = await buildSupervisor(cfg);
if (!(await deps.sandbox.available())) throw new Error('Deno is required for the browser journey');

// regulations.gov, as the journey's program calls it.
const mock = new MockAgent();
mock.disableNetConnect();
mock.get('https://api.regulations.gov').intercept({ path: '/v4/dockets/EPA-HQ-OAR-2021-0208', method: 'GET' })
  .reply(200, { data: { id: 'EPA-HQ-OAR-2021-0208', attributes: { title: 'Journey docket' } } }).persist();
// Key checks: regulations.gov accepts any key here.
const acceptKeys = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

const service = await createAccountApp(config, store, accountDependencies(deps, cfg, store, mock), acceptKeys, publicDependencies(await buildSupervisor(cfg), origin));
const helper = testUtils().init((await service.auth.$context) as unknown as Parameters<ReturnType<typeof testUtils>['init']>[0]).context.test;
const user = await helper.saveUser(helper.createUser({ email: 'ada@example.test', emailVerified: true }));
const { cookies } = await helper.login({ userId: user.id });
// Owner-only, and never overwrite a file someone else placed there.
writeFileSync(statePath, JSON.stringify({ origin, cookies: cookies.map((c: { name: string; value: string }) => ({ name: c.name, value: c.value })) }), { mode: 0o600, flag: 'wx' });

const server = createServer(service.app);
server.listen(PORT, '127.0.0.1', () => process.stderr.write(`journey server on ${origin}\n`));

const stop = async () => {
  server.close();
  await service.close();
  await mock.close();
  await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
