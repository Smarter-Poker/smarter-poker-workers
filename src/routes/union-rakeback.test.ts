import { describe, it, expect } from 'vitest';
import { unionRakeback } from './union-rakeback.js';

function makeCtx() {
  const captured: { body: unknown; status: number } = { body: null, status: 0 };
  return {
    captured,
    json(body: unknown, status = 200) {
      captured.body = body;
      captured.status = status;
      return body;
    },
  } as unknown as Parameters<typeof unionRakeback>[0] & {
    readonly captured: { body: unknown; status: number };
  };
}

describe('GET/POST /cron/union-rakeback (retired)', () => {
  it('refuses to move money and returns 410', async () => {
    const ctx = makeCtx();
    await unionRakeback(ctx);
    const { body, status } = (ctx as any).captured as {
      body: { success: boolean; retired: boolean; error: string };
      status: number;
    };
    expect(status).toBe(410);
    expect(body.success).toBe(false);
    expect(body.retired).toBe(true);
    expect(body.error).toBe('union_rakeback_route_retired');
  });

  it('has no executable database access left in it', async () => {
    // A retired money route that can still reach the database is one edit
    // away from paying again. Assert against CODE only — the tombstone
    // comment is allowed (and required) to describe what it used to do.
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./union-rakeback.ts', import.meta.url), 'utf8'),
    );
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('getSupabase');
    expect(code).not.toContain('rake_wallet');
    expect(code).not.toContain('fn_credit_treasury');
    expect(code).not.toContain('fn_union_debit_wallet');
    expect(code).not.toContain('from(');
  });
});
