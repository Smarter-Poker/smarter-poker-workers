import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Multi-account detector v2 law (Dan, 2026-10-22): "do not flag
 * smarter.poker official or any admin accounts ever ... truly only flag
 * multiple accounts, not multiple log ins".
 *
 * v1 grouped raw audit rows by IP and flagged every account in the group.
 * These tests keep that shape from coming back: the route must use the v2
 * rules in detect_multi_account_v2 and must never fall back to grouping raw
 * action_audit_logs rows by IP.
 */
const code = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'anti-cheat-multi-account.ts'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

describe('multi-account detector v2', () => {
  it('uses the v2 rules', () => {
    expect(code).toMatch(/rpc\(\s*['"`]detect_multi_account_v2['"`]/);
    expect(code).toMatch(/multi_account_v2/);
  });

  it('never falls back to the retired v1 IP grouping', () => {
    expect(code).not.toMatch(/detect_multi_account_ips/);
    expect(code).not.toMatch(/from\(\s*['"`]action_audit_logs['"`]\s*\)/);
    expect(code).not.toMatch(/multi_account_ip_match_v1/);
  });

  it('flags a pair, not a whole IP group', () => {
    expect(code).toMatch(/other_user_ids:\s*\[otherId\]/);
  });
});
