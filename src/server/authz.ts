import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { log } from '../util/logger.js';

export interface AuthConfig {
  provider: 'none' | 'embedded' | 'generic-oidc' | 'clerk' | 'workos' | 'auth0';
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
  resource?: string;
  scopes?: string[];
}

export interface AuthContext {
  subject: string;
  claims: JWTPayload;
}

export interface Verifier {
  verify(token: string): Promise<AuthContext>;
}

class NoopVerifier implements Verifier {
  async verify(): Promise<AuthContext> {
    return { subject: 'anonymous', claims: {} };
  }
}

class OidcVerifier implements Verifier {
  private jwks: ReturnType<typeof createRemoteJWKSet>;
  constructor(private readonly cfg: AuthConfig) {
    if (!cfg.jwksUrl) throw new Error('FEDREG_AUTH_JWKS_URL is required for OIDC verifiers');
    this.jwks = createRemoteJWKSet(new URL(cfg.jwksUrl));
  }
  async verify(token: string): Promise<AuthContext> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.cfg.issuer,
      audience: this.cfg.audience,
    });
    const sub = String(payload.sub ?? 'unknown');
    return { subject: sub, claims: payload };
  }
}

export function buildVerifier(cfg: AuthConfig): Verifier {
  switch (cfg.provider) {
    case 'none':
    case 'embedded':
      if (cfg.provider === 'embedded') log.warn('authz.embedded_dev_only');
      return new NoopVerifier();
    case 'generic-oidc':
    case 'clerk':
    case 'workos':
    case 'auth0':
      return new OidcVerifier(cfg);
    default:
      return new NoopVerifier();
  }
}
