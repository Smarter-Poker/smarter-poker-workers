import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from './testing/fakeSupabase.js';

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../supabase.js', () => ({ getSupabase: () => state.client }));

import * as ledger from './ContentLedger.js';
import { writeCaption } from './VoiceWriter.js';
import { composeCaption } from './Composer.js';
import { briefForAsset } from './PostBrief.js';
import { styleSheetFor } from './StyleSheet.js';

const now = new Date('2026-10-16T00:00:00Z');
const horse = { profile_id: '46887b99-8cd6-45db-861c-ad24232efbfe', name: 'Quinn Ivorson' };
const asset = {kind:'video' as const,title:'Bluffing With Nine Seven!',source:'Mariano',domainHint:'poker' as const};
let db: FakeDb;
const age = (ms: number) => new Date(now.getTime() - ms).toISOString();
const hour = 3_600_000;
const day = 24 * hour;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db = new FakeDb(); state.client = db.client;
  ledger._resetLedgerReadFailures();
});
afterEach(() => vi.restoreAllMocks());

describe('video semantic ledger matches the authoritative RPC windows', () => {
  it.each([
    ['global inclusive boundary', 'other', 48 * hour, true],
    ['global expired', 'other', 48 * hour + 1, false],
    ['same horse inclusive boundary', horse.profile_id, 90 * day, true],
    ['same horse expired', horse.profile_id, 90 * day + 1, false],
  ])('%s', async (_label, horseId, ageMs, expected) => {
    db.seed('horse_semantic_ledger', [{id:'s',semantic_key:'meaning:fact',horse_id:horseId,used_at:age(Number(ageMs))}]);
    expect(await ledger.videoSemanticRecentlyUsed('meaning:fact',horse.profile_id)).toBe(expected);
  });

  it('does not reject another genuinely different meaning', async () => {
    db.seed('horse_semantic_ledger', [{id:'s',semantic_key:'meaning:other-fact',horse_id:'other',used_at:age(0)}]);
    expect(await ledger.videoSemanticRecentlyUsed('meaning:fact',horse.profile_id)).toBe(false);
  });

  it.each(['global','horse'])('fails closed and counts an unreadable %s read', async kind => {
    db.fail(op => op.table === 'horse_semantic_ledger' && (kind === 'global' || op.filters.includes('eq:horse_id')));
    expect(await ledger.videoSemanticRecentlyUsed('meaning:fact',horse.profile_id)).toBe(true);
    expect(ledger.ledgerReadFailures()).toEqual({semantic:1});
  });

  it('fails closed on a thrown transport failure', async () => {
    state.client = {from:()=>{throw new Error('transport unavailable');}};
    expect(await ledger.videoSemanticRecentlyUsed('meaning:fact',horse.profile_id)).toBe(true);
    expect(ledger.ledgerReadFailures()).toEqual({semantic:1});
  });
});

describe('real caption writer and real semantic ledger', () => {
  function drafts() {
    return Array.from({length:6},(_,i)=>composeCaption(briefForAsset(asset),styleSheetFor(horse.profile_id),String(i)));
  }

  it('rejects a used video meaning and tries a genuinely new source-grounded angle', async () => {
    const first = drafts()[0]!;
    db.seed('horse_semantic_ledger', [{id:'s',semantic_key:first.semanticKey,horse_id:'other',used_at:age(0)}]);
    const out = await writeCaption(horse,asset);
    expect(out.text).not.toBe('');
    expect(out.semanticKey).not.toBe(first.semanticKey);
    expect(out.semanticKey).toBe(drafts()[1]!.semanticKey);
    expect(out.attempts).toBe(2);
    expect(db.log.every(op=>op.kind==='select')).toBe(true);
  });

  it('retains legacy semantic keys stored in the phrase ledger', async () => {
    db.seed('horse_phrase_ledger', [{id:'p',phrase_norm:drafts()[0]!.semanticKey,horse_id:'other',used_at:age(0)}]);
    expect((await writeCaption(horse,asset)).semanticKey).toBe(drafts()[1]!.semanticKey);
  });

  it('queries each conclusively refused meaning once per invocation, not once per repeated variant', async () => {
    const keys = [...new Set(drafts().map(x=>x.semanticKey))];
    expect(keys.length).toBe(3);
    db.seed('horse_semantic_ledger',keys.map((key,i)=>({id:String(i),semantic_key:key,horse_id:'other',used_at:age(0)})));
    expect((await writeCaption(horse,asset)).stale).toBe(true);
    expect(db.log.filter(op=>op.table==='horse_semantic_ledger')).toHaveLength(3);
    db.tables.horse_semantic_ledger=[];
    expect((await writeCaption(horse,asset)).text).not.toBe('');
  });

  it('never memoizes unreadable ledger refusals as conclusively used', async () => {
    db.fail(op=>op.table==='horse_semantic_ledger');
    expect((await writeCaption(horse,asset)).text).toBe('');
    expect(db.log.filter(op=>op.table==='horse_semantic_ledger')).toHaveLength(6);
    expect(ledger.ledgerReadFailures().semantic).toBe(6);
  });

  it('memoizes positive rendered-phrase collisions but never caches fresh semantic checks', async () => {
    const norms = [...new Set(drafts().map(x=>ledger.normalizePhrase(x.text)))];
    expect(norms).toHaveLength(3);
    db.seed('horse_phrase_ledger',norms.map((norm,i)=>({id:String(i),phrase_norm:norm,horse_id:'other',used_at:age(0)})));
    expect((await writeCaption(horse,asset)).stale).toBe(true);
    // Six genuinely unused meaning checks each retain both windows; three
    // conclusive rendered-text collisions each need only the global lookup.
    expect(db.log.filter(op=>op.table==='horse_semantic_ledger')).toHaveLength(12);
    expect(db.log.filter(op=>op.table==='horse_phrase_ledger')).toHaveLength(12+3);
  });

  it('does not memoize an unreadable legacy phrase guard', async () => {
    db.fail(op=>op.table==='horse_phrase_ledger');
    expect((await writeCaption(horse,asset)).text).toBe('');
    expect(db.log.filter(op=>op.table==='horse_phrase_ledger')).toHaveLength(6);
    expect(ledger.ledgerReadFailures().phrase).toBe(6);
  });

  it('leaves non-video caption semantics on the existing legacy gate', async () => {
    db.fail(op=>op.table==='horse_semantic_ledger');
    expect((await writeCaption(horse,{...asset,kind:'link'})).text).not.toBe('');
    expect(db.log.filter(op=>op.table==='horse_semantic_ledger')).toHaveLength(0);
  });
});
