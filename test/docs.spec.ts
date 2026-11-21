import { describe, it, expect } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { docsHandler } from '../src/accounts/docs.js';

// The docs share the portal's cookie origin, so their CSP allows inline scripts only by hash.
describe('documentation site handler', () => {
  it('serves the built site with hashed inline scripts, caching, and no escape from its root', async () => {
    expect(docsHandler(mkdtempSync(join(tmpdir(), 'docs-empty-')))).toBeUndefined();

    const parent = mkdtempSync(join(tmpdir(), 'docs-site-'));
    const root = join(parent, 'site');
    mkdirSync(root);
    const inline = "document.documentElement.dataset.theme='dark'";
    writeFileSync(join(root, 'index.html'), `<html><script>${inline}</script><script src="/docs/_astro/a.js"></script></html>`);
    writeFileSync(join(root, '404.html'), '<html>Not found</html>');
    mkdirSync(join(root, '_astro'));
    writeFileSync(join(root, '_astro', 'a.js'), 'console.log(1)');
    writeFileSync(join(parent, 'outside.txt'), 'secret');

    const handler = docsHandler(root)!;
    const app = express().use('/docs', handler);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(`${base}/docs/`);
      expect(page.status).toBe(200);
      const csp = page.headers.get('content-security-policy')!;
      expect(csp).toContain(`'sha256-${createHash('sha256').update(inline).digest('base64')}'`);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(page.headers.get('cache-control')).toBe('public, max-age=300');

      const asset = await fetch(`${base}/docs/_astro/a.js`);
      expect(asset.headers.get('cache-control')).toContain('immutable');
      await asset.arrayBuffer();

      const port = (server.address() as AddressInfo).port;
      // fetch() normalizes dot segments before sending, so traversal needs a raw request line.
      const raw = (path: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          get({ host: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          }).on('error', reject);
        });
      for (const path of ['/docs/missing/', '/docs/../outside.txt', '/docs/%2e%2e/outside.txt', '/docs/..%2foutside.txt']) {
        const response = await raw(path);
        expect(response.status, path).toBe(404);
        expect(response.body, path).not.toContain('secret');
      }
      expect((await fetch(`${base}/docs/`, { method: 'POST' })).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it.skipIf(process.getuid?.() === 0)('reports a file it cannot read as a server error, not a 404', async () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-locked-'));
    writeFileSync(join(root, 'index.html'), '<html></html>');
    writeFileSync(join(root, '404.html'), '<html>Not found</html>');
    const locked = join(root, 'locked.html');
    writeFileSync(locked, '<html></html>');
    // The handler reads every page once at startup (for the CSP hashes); lock the file after that.
    const app = express().use('/docs', docsHandler(root)!);
    chmodSync(locked, 0o000);
    app.use(((_err, _req, res, _next) => { res.status(500).end('error'); }) as express.ErrorRequestHandler);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/docs/locked.html`);
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBeNull();
      expect(await res.text()).toBe('error');
    } finally {
      chmodSync(locked, 0o600);
      server.close();
    }
  });
});
