import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Multi-account detector law (Dan, 2026-10-22): "do not flag
 * smarter.poker official or any admin accounts ever ... truly only flag
 * multiple accounts, not multiple log ins".
 *
 * v1 grouped raw audit rows by IP and flagged every account in the group.
 * These tests keep that shape from coming back: the route must use the v3
 * rules in detect_multi_account_v3 (device, shared hands, household
 * addresses) and must never fall back to grouping raw action_audit_logs rows.
 */
const code = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'anti-cheat-multi-account.ts'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

describe('multi-account detector', () => {
  it('uses the v3 rules', () => {
    expect(code).toMatch(/rpc\(\s*['"`]detect_multi_account_v3['"`]/);
    expect(code).toMatch(/multi_account_v3/);
  });

  it('never falls back to the retired IP grouping', () => {
    expect(code).not.toMatch(/detect_multi_account_ips/);
    expect(code).not.toMatch(/detect_multi_account_v2/);
    expect(code).not.toMatch(/from\(\s*['"`]action_audit_logs['"`]\s*\)/);
    expect(code).not.toMatch(/multi_account_ip_match_v1/);
  });

  it('flags a pair, not a whole IP group, and records its evidence', () => {
    expect(code).toMatch(/other_user_ids:\s*\[otherId\]/);
    expect(code).toMatch(/evidence:\s*p\.evidence/);
    expect(code).toMatch(/shared_hands:\s*p\.shared_hands/);
  });

  it('keeps the published shared-address lists current', () => {
    expect(code).toMatch(/refreshOneStaleSource\(/);
  });
});
