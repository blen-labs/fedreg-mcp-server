import type { Dispatcher } from 'undici';
import { HttpClient } from '../util/httpClient.js';
import { FederalRegisterClient } from './fr-client.js';
import { EcfrClient } from './ecfr-client.js';

export interface SdkConfig {
  frBaseUrl: string;
  ecfrBaseUrl: string;
  userAgent: string;
  timeoutMs: number;
  retries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  dispatcher?: Dispatcher;
}

export function buildSdk(cfg: SdkConfig) {
  const common = {
    userAgent: cfg.userAgent,
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
    cacheTtlMs: cfg.cacheTtlMs,
    cacheMaxItems: cfg.cacheMaxItems,
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  };
  const frHttp = new HttpClient({ baseUrl: cfg.frBaseUrl, ...common });
  const ecfrHttp = new HttpClient({ baseUrl: cfg.ecfrBaseUrl, ...common });
  return {
    fr: new FederalRegisterClient(frHttp),
    ecfr: new EcfrClient(ecfrHttp),
    version: () => '0.1.0-alpha.0',
  };
}

export type Sdk = ReturnType<typeof buildSdk>;
