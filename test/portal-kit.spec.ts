import { describe, expect, it } from 'vitest';
import { drift } from '../scripts/portal-kit.mjs';

describe('portal kit', () => {
  it('matches web/portal-kit.json (shared byte for byte with the other BLEN MCP servers)', () => {
    expect(drift()).toEqual([]);
  });
});
