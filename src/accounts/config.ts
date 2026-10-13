import { Keyring } from './crypto.js';

export interface AccountConfig {
  origin: string;
  production: boolean;
  databaseUrl: string;
  authSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  keyring: Keyring;
  subjectDailyQuota?: number;
  /** Header the reverse proxy overwrites with the client address (Railway: x-real-ip). */
  clientIpHeader?: string;
}

/** `env` is passed in by src/bin.ts, the only module that reads process.env. */
export function loadAccountConfig(env: Record<string, string | undefined>): AccountConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value || value.includes('REPLACE_WITH_')) throw new Error(`Missing configuration: ${name}`);
    return value;
  };
  const origin = new URL(required('FEDREG_PUBLIC_ORIGIN'));
  const production = env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test';
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
      (origin.protocol !== 'https:' && (production || origin.protocol !== 'http:' ||
       !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('FEDREG_PUBLIC_ORIGIN must be an HTTPS origin (HTTP loopback allowed in development)');
  }
  const authSecret = required('BETTER_AUTH_SECRET');
  if (authSecret.length < 32) throw new Error('BETTER_AUTH_SECRET must have at least 32 characters');
  let encoded: unknown;
  const encodedKeys = required('ENCRYPTION_KEYS_JSON');
  try { encoded = JSON.parse(encodedKeys); }
  catch { throw new Error('ENCRYPTION_KEYS_JSON must be valid JSON'); }
  if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)) throw new Error('Invalid encryption keyring');
  const keys = Object.fromEntries(Object.entries(encoded).map(([id, value]) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Invalid base64 encryption key');
    return [id, Buffer.from(value, 'base64')];
  }));
  const subjectDailyQuota = Number(env.FEDREG_SUBJECT_DAILY_QUOTA ?? 10000);
  if (!Number.isInteger(subjectDailyQuota) || subjectDailyQuota < 1) throw new Error('FEDREG_SUBJECT_DAILY_QUOTA must be a positive integer');
  const clientIpHeader = env.FEDREG_CLIENT_IP_HEADER?.trim().toLowerCase() || undefined;
  if (clientIpHeader && !/^[a-z0-9-]+$/.test(clientIpHeader)) throw new Error('FEDREG_CLIENT_IP_HEADER must be a header name');
  return {
    subjectDailyQuota, clientIpHeader,
    origin: origin.origin, production, authSecret,
    databaseUrl: required('DATABASE_URL'),
    googleClientId: required('GOOGLE_CLIENT_ID'),
    googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
    keyring: new Keyring(required('ENCRYPTION_ACTIVE_KEY_ID'), keys),
  };
}
