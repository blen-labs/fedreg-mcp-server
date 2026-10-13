import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface Sealed {
  v: 1;
  kid: string;
  iv: string;
  tag: string;
  data: string;
}

const TAG_BYTES = 16;

/** AEAD binds each ciphertext to its purpose and owner, preventing row swapping. */
export class Keyring {
  constructor(
    readonly activeId: string,
    private readonly keys: Record<string, Buffer>,
  ) {
    if (!Object.hasOwn(keys, activeId) || Object.values(keys).some((key) => key.length !== 32)) {
      throw new Error('Encryption keys must be 32 bytes; active key must exist');
    }
  }
  seal(value: string, context: string): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys[this.activeId]!, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(JSON.stringify([1, this.activeId, context])));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      v: 1,
      kid: this.activeId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    };
  }
  open(value: Sealed, context: string): string {
    const key = Object.hasOwn(this.keys, value.kid) ? this.keys[value.kid] : undefined;
    if (value.v !== 1 || !key) throw new Error('Unsupported ciphertext');
    // A fixed tag length: GCM otherwise accepts truncated tags as short as 4 bytes.
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(JSON.stringify([1, value.kid, context])));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
