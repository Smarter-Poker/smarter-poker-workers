import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OWNER_ACCOUNT_ID,
  OperationalNoticeUnmarked,
  OwnerOperationalNoticeRefused,
  insertOperationalNotices,
  splitOwnerCopy,
  type OperationalNoticeMarker,
} from './ownerOperationalRouting.js';

const OTHER = 'bbbbbbbb-0000-4000-8000-000000000001';
const MARKER: OperationalNoticeMarker = {
  component: 'workers.auto-settlement', alertname: 'UnionPlayerPnlFailed', severity: 'critical',
};
const row = (user_id: string, data: Record<string, unknown> = { union_id: 'u-1', failed: true }) => ({
  user_id, type: 'settlement', title: 'Weekly player P&L failed', message: 'm', data, read: false as const,
});
function fakeClient(result: { error: null | { message: string } } = { error: null }) {
  const writes: Array<{ table: string; rows: unknown }> = [];
  const client = {
    from: (table: string) => ({
      insert: async (rows: unknown) => {
        writes.push({ table, rows });
        return result;
      },
    }),
  };
  return { writes, client };
}

describe('the owner account never receives an operational notice personally', () => {
  it('is exactly the owner account, and only that account is excluded', () => {
    expect(OWNER_ACCOUNT_ID).toBe('47965354-0e56-43ef-931c-ddaab82af765');
    expect(splitOwnerCopy([OTHER])).toEqual({ personal: [OTHER], ownerCopy: false });
  });

  it('takes the owner account out of the personal recipients and reports its copy', () => {
    expect(splitOwnerCopy([OWNER_ACCOUNT_ID, OTHER, OTHER, null, undefined, '']))
      .toEqual({ personal: [OTHER], ownerCopy: true });
    expect(splitOwnerCopy([` ${OWNER_ACCOUNT_ID.toUpperCase()} `])).toEqual({ personal: [], ownerCopy: true });
  });

  it('refuses, before any write, a batch that addresses the owner account', async () => {
    const { writes, client } = fakeClient();
    await expect(insertOperationalNotices(client as never, MARKER, [row(OTHER), row(OWNER_ACCOUNT_ID)]))
      .rejects.toBeInstanceOf(OwnerOperationalNoticeRefused);
    expect(writes).toEqual([]);
  });

  it('refuses, before any write, a batch without a complete marker', async () => {
    for (const marker of [undefined, {}, { ...MARKER, component: ' ' }, { ...MARKER, alertname: '' },
      { ...MARKER, severity: 'loud' }]) {
      const { writes, client } = fakeClient();
      await expect(insertOperationalNotices(client as never, marker as never, [row(OTHER)]))
        .rejects.toBeInstanceOf(OperationalNoticeUnmarked);
      expect(writes).toEqual([]);
    }
  });

  // The marker is what lets the database classifier recognise an operational
  // notice from the row alone; everything the sender wrote stays as it was.
  it('writes every other recipient unchanged apart from the marker in its data, and reports a database refusal', async () => {
    const ok = fakeClient();
    await expect(insertOperationalNotices(ok.client as never, MARKER, [row(OTHER)]))
      .resolves.toEqual({ inserted: 1, error: null });
    expect(ok.writes).toEqual([{ table: 'notifications', rows: [row(OTHER, {
      union_id: 'u-1', failed: true,
      component: 'workers.auto-settlement', alertname: 'UnionPlayerPnlFailed', severity: 'critical',
    })] }]);
    const refused = fakeClient({ error: { message: 'insert refused' } });
    await expect(insertOperationalNotices(refused.client as never, MARKER, [row(OTHER)]))
      .resolves.toEqual({ inserted: 0, error: 'insert refused' });
  });

  it('is the only way the settlement problem sender writes a notification, always with its marker', () => {
    const source = readFileSync(fileURLToPath(new URL('../routes/auto-settlement.ts', import.meta.url)), 'utf8');
    const start = source.indexOf('async function notifyUnionSettlementProblem(');
    const end = source.indexOf('export async function autoSettlement(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const sender = source.slice(start, end);
    expect(sender).toContain('split: typeof splitOwnerCopy = splitOwnerCopy');
    expect(sender).toContain('split(recipients)');
    expect(sender).toContain('insertOperationalNotices(');
    expect(sender).toContain('problemNoticeMarker(evidence.kind)');
    expect(sender).not.toContain("from('notifications')");
  });
});
