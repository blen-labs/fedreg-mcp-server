import type { Pool } from 'pg';
import { Keyring, type Sealed, digest } from './crypto.js';

/** Personal credential owner derived exclusively from the authenticated user. */
export const personalOwner = (userId: string) => `user:${userId}`;

export class Store {
  constructor(
    readonly pool: Pool,
    private readonly keyring: Keyring,
  ) {}
  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // IF NOT EXISTS alone does not serialize simultaneous first-time DDL.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fedreg-store-migration'))");
      await client.query(`
      CREATE TABLE IF NOT EXISTS credentials (
        owner TEXT PRIMARY KEY,
        ciphertext JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS connection_steps (
        session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_limits (
        bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGSERIAL PRIMARY KEY, tenant TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async saveKey(owner: string, key: string, actor?: string) {
    return this.persistKey(owner, key, actor);
  }
  private async persistKey(
    owner: string,
    key: string,
    actor: string | undefined,
  ) {
    const ciphertext = this.keyring.seal(key, `regulations.gov:${owner}`);
    return this.changeKey(
      owner,
      actor,
      'credential.saved',
      `INSERT INTO credentials(owner,ciphertext) VALUES($1,$2)
      ON CONFLICT(owner) DO UPDATE SET ciphertext=$2,updated_at=now()`,
      [owner, ciphertext],
    );
  }
  async getKey(owner: string) {
    const result = await this.pool.query('SELECT ciphertext FROM credentials WHERE owner=$1', [
      owner,
    ]);
    return result.rows[0]
      ? this.keyring.open(result.rows[0].ciphertext as Sealed, `regulations.gov:${owner}`)
      : undefined;
  }
  async keyStatus(owner: string) {
    const result = await this.pool.query('SELECT updated_at FROM credentials WHERE owner=$1', [
      owner,
    ]);
    return { connected: result.rowCount === 1, updatedAt: result.rows[0]?.updated_at };
  }
  async deleteKey(owner: string, actor?: string) {
    await this.changeKey(
      owner,
      actor,
      'credential.deleted',
      'DELETE FROM credentials WHERE owner=$1',
      [owner],
    );
  }
  private async changeKey(
    owner: string,
    actor: string | undefined,
    action: string,
    sql: string,
    values: unknown[],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql, values);
      if (actor)
        await client.query('INSERT INTO audit_events(tenant,actor,action) VALUES($1,$2,$3)', [
          owner,
          actor,
          action,
        ]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async markConnectionReady(sessionId: string, userId: string) {
    await this.pool.query(
      `INSERT INTO connection_steps(session_id,user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')
      ON CONFLICT(session_id) DO UPDATE SET user_id=$2,expires_at=now()+interval '10 minutes'`,
      [sessionId, userId],
    );
  }
  async connectionReady(sessionId: string, userId: string) {
    const result = await this.pool.query(
      'SELECT 1 FROM connection_steps WHERE session_id=$1 AND user_id=$2 AND expires_at>now()',
      [sessionId, userId],
    );
    return result.rowCount === 1;
  }
  async clearConnectionStep(sessionId: string) {
    await this.pool.query('DELETE FROM connection_steps WHERE session_id=$1', [sessionId]);
  }
  async allow(bucket: string, maximum: number, seconds: number) {
    const result = await this.pool.query(
      `INSERT INTO request_limits(bucket,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN request_limits.expires_at<=now() THEN 1 ELSE request_limits.count+1 END,
      expires_at=CASE WHEN request_limits.expires_at<=now() THEN now()+$2*interval '1 second' ELSE request_limits.expires_at END RETURNING count`,
      [digest(bucket), seconds],
    );
    return result.rows[0].count <= maximum;
  }
  async rotateKeys(batchSize = 100) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
      throw new Error('Invalid rotation batch size');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query(
        "SELECT owner,ciphertext FROM credentials WHERE ciphertext->>'kid' <> $1 ORDER BY owner LIMIT $2 FOR UPDATE",
        [this.keyring.activeId, batchSize],
      );
      for (const row of rows.rows) {
        const context = `regulations.gov:${row.owner}`;
        const sealed = this.keyring.seal(this.keyring.open(row.ciphertext, context), context);
        await client.query('UPDATE credentials SET ciphertext=$2 WHERE owner=$1', [
          row.owner,
          sealed,
        ]);
        await client.query('INSERT INTO audit_events(tenant,actor,action) VALUES($1,$2,$3)', [
          row.owner,
          'service-operator',
          'credential.reencrypted',
        ]);
      }
      await client.query('COMMIT');
      return rows.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async cleanup() {
    await this.pool.query('DELETE FROM request_limits WHERE expires_at<now()');
    await this.pool.query('DELETE FROM connection_steps WHERE expires_at<now()');
  }
}
