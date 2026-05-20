/**
 * Embedded auth: a dev-only HS256 issuer for local testing.
 * Do not use in production.
 */
import { SignJWT } from 'jose';

export async function mintDevToken(secret: string, subject: string, audience: string, ttlSec = 3600): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('fedreg-mcp-server/embedded')
    .setSubject(subject)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec)
    .sign(key);
}
