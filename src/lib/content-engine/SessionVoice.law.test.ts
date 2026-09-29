/**
 * Laws for the grounded-session voice (P3C-11).
 *
 * The old session writer printed the row: "Rough one. 1684 hands, -2040bb."
 * These tests hold the replacement to HandVoice's rules: no numbers, no big
 * blinds, no hand counts, no StyleSheet filler, every word from the module's
 * own vocabulary (so no name can appear), and no claim the row does not make.
 *
 * The rows are the 21 real horse_daily_nets days the p3-handvoice-c
 * investigator md5-verified against production, run through the real
 * pickSessionStory against a SELECT-only fake client whose writes throw.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SessionFacts } from './HandStory.js';
import { pickSessionStory } from './HandStory.js';
import {
  briefForSpokenSession,
  sayGame,
  sessionGroup,
  sessionLineFor,
  sessionLineMatches,
} from './SessionVoice.js';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, writes: [] as string[] }));

vi.mock('../supabase.js', () => {
  function builder(table: string): unknown {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const b: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const res = { data: rows(), error: null };
          return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(res).then(ok, bad);
        }
        if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
        if (prop === 'eq') return (k: string, v: unknown) => { filters.push((r) => !(k in r) || String(r[k]) === String(v)); return b; };
        if (prop === 'in') return (k: string, vs: unknown[]) => { const set = new Set(vs.map(String)); filters.push((r) => !(k in r) || set.has(String(r[k]))); return b; };
        if (prop === 'like') return (k: string, p: string) => { const pre = p.replace(/%$/, ''); filters.push((r) => String(r[k] ?? '').startsWith(pre)); return b; };
        if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
          return () => { db.writes.push(`${table}.${String(prop)}`); throw new Error(`zero-write test: ${String(prop)} on ${table}`); };
        }
        return () => b;
      },
    });
    return b;
  }
  return {
    DEFAULT_REQUEST_TIMEOUT_MS: 20_000,
    getSupabase: () => ({ from: (t: string) => builder(t), rpc: () => { db.writes.push('rpc'); throw new Error('zero-write test: rpc'); } }),
  };
});

/** Real days: direction, day, variant, format, hands, net big blinds. */
const DAYS: Array<[string, string, string, string, number, string]> = [
  ['up', '2026-09-20', 'nlh', 'tournament', 113, '191.05'],
  ['up', '2026-09-18', 'pineapple', 'cash', 433, '665.24'],
  ['up', '2026-09-18', 'plo4', 'tournament', 246, '98.43'],
  ['up', '2026-09-20', 'plo5', 'cash', 651, '418.46'],
  ['up', '2026-09-18', 'plo6', 'tournament', 194, '67.69'],
  ['up', '2026-09-18', 'plo8', 'cash', 1067, '335.58'],
  ['up', '2026-09-18', 'short_deck', 'cash', 282, '890.51'],
  ['up', '2026-09-21', 'nlh', 'cash', 46, '337.86'],
  ['up', '2026-09-18', 'nlh', 'hu_cash', 133, '155.78'],
  ['flat', '2026-09-18', 'nlh', 'tournament', 44, '0.90'],
  ['flat', '2026-09-18', 'nlh', 'tournament', 87, '2.98'],
  ['flat', '2026-09-18', 'nlh', 'tournament', 113, '3.98'],
  ['down', '2026-09-19', 'flh', 'cash', 953, '-256.45'],
  ['down', '2026-09-18', 'flo8', 'cash', 651, '-177.76'],
  ['down', '2026-09-18', 'nlh', 'cash', 1684, '-2040.20'],
  ['down', '2026-09-18', 'nlh', 'tournament', 89, '-18.51'],
  ['down', '2026-09-20', 'pineapple', 'cash', 449, '-421.48'],
  ['down', '2026-09-18', 'plo4', 'cash', 529, '-607.20'],
  ['down', '2026-09-18', 'plo6', 'cash', 1012, '-1726.62'],
  ['down', '2026-09-19', 'plo8', 'hu_cash', 5894, '-853.64'],
  ['down', '2026-09-18', 'short_deck', 'cash', 138, '-492.99'],
];

const HORSE = 'horse-under-test';

async function factsOf(day: (typeof DAYS)[number]): Promise<SessionFacts> {
  const [, d, game_variant, format, hands, net_bb] = day;
  db.tables = { horse_daily_nets: [{ horse_user_id: HORSE, day: d, game_variant, format, hands, net_bb }] };
  const f = await pickSessionStory(HORSE);
  expect(f, `${d} ${game_variant} ${format}`).not.toBeNull();
  return f!;
}

function rendered(s: SessionFacts): Array<{ text: string; key: string }> {
  const lines = new Map<string, { text: string; key: string }>();
  for (let i = 0; i < 300; i += 1) {
    const line = sessionLineFor(s, `seed-${i}`);
    if (line) lines.set(line.key, line);
  }
  return [...lines.values()];
}

const SOURCE = readFileSync(new URL('./SessionVoice.ts', import.meta.url), 'utf8');
const VOCABULARY = new Set((SOURCE.match(/[A-Za-z]+/g) ?? []).map((w) => w.toLowerCase()));

const UP = /good day|good to me|big day|booked|\bwin\b|picked up|went my way|kind to|chipped up|finished up|up on the day|left the tables up|nice day/i;
const DOWN = /rough|brutal|\blost\b|losing|not my day|better of me|took a hit|finished down|down on the day|didn't go my way|wrong way/i;
const FLAT = /broke even|nowhere|where i started|flat day|about even/i;

describe('a day is said the way a player says it', () => {
  it('groups a day by its result, with a flat band in the middle', () => {
    const base: SessionFacts = { day: '2026-09-18', variant: 'nlh', format: 'cash', hands: 100, netBb: 0 };
    expect(sessionGroup({ ...base, netBb: 5.1 })).toBe('up');
    expect(sessionGroup({ ...base, netBb: 5 })).toBe('flat');
    expect(sessionGroup({ ...base, netBb: -5 })).toBe('flat');
    expect(sessionGroup({ ...base, netBb: -5.1 })).toBe('down');
  });

  it('names the game only as far as the variant code proves', () => {
    const at = (variant: string): SessionFacts => ({ day: '2026-09-18', variant, format: 'cash', hands: 100, netBb: 80 });
    expect(sayGame(at('nlh'))).toBe('no limit hold\'em');
    expect(sayGame(at('plo5'))).toBe('five-card PLO');
    expect(sayGame(at('short_deck'))).toBe('short deck');
    expect(sayGame(at('something_new'))).toBeNull();
    // An unknown variant still has lines that do not need the game.
    const lines = rendered(at('something_new'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.text).not.toMatch(/something|new/i);
  });

  it('renders variety in every direction and falls silent when the pool is used up', () => {
    for (const netBb of [120, -120, 1]) {
      const s: SessionFacts = { day: '2026-09-18', variant: 'nlh', format: 'cash', hands: 300, netBb };
      expect(rendered(s).length, `net ${netBb}`).toBeGreaterThanOrEqual(5);
      const used = new Set<string>();
      while (true) {
        const line = sessionLineFor(s, 'fixed-seed', used);
        if (!line) break;
        expect(used.has(line.key)).toBe(false);
        used.add(line.key);
      }
      expect(used.size).toBeGreaterThanOrEqual(5);
      expect(sessionLineFor(s, 'another-seed', used)).toBeNull();
    }
  });
});

describe('every line about a real day keeps the laws (P3C-11)', () => {
  it('no numbers, no big blinds, no hand counts, no filler, no names, and the day it actually had', async () => {
    for (const day of DAYS) {
      const s = await factsOf(day);
      const group = sessionGroup(s);
      expect(group).toBe(day[0]);
      const lines = rendered(s);
      expect(lines.length, `${day.join(' ')} has nothing to say`).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        const label = `${day.join(' ')}: ${line.text}`;
        expect(sessionLineMatches(line.text, s), label).toBe(true);
        expect(line.text, label).not.toMatch(/\d/);
        expect(line.text, label).not.toMatch(/\bbb\b|big blind|\bhands?\b|volume/i);
        expect(line.text, label).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(line.text, label).not.toMatch(/[–—]|\.\.\.|…|\?/);
        expect(line.text, label).not.toMatch(/^(?:look|nah|okay|ok|well|honestly|so|yeah|rough one|what gets me|the thing is|the interesting part|for me)\b/i);
        expect(line.text, label).not.toMatch(/decisions were fine|cards were the cards|variance is real|volume is the only/i);
        expect(line.text[0], label).toMatch(/[A-Z]/);
        expect(line.text, label).not.toMatch(/[.!?]\s+[a-z]/);
        for (const word of line.text.match(/[A-Za-z]+/g) ?? []) {
          expect(VOCABULARY.has(word.toLowerCase()), `${label} (word "${word}")`).toBe(true);
        }
        // Direction.
        if (group !== 'up') expect(line.text, label).not.toMatch(UP);
        if (group !== 'down') expect(line.text, label).not.toMatch(DOWN);
        if (group !== 'flat') expect(line.text, label).not.toMatch(FLAT);
        // Tournament days are chips, never money; cash days are not tournaments.
        if (s.format === 'tournament') expect(line.text, label).not.toMatch(/\btables\b|booked|\bwin\b|cash/i);
        else expect(line.text, label).not.toMatch(/tournament/i);
        if (s.format !== 'hu_cash') expect(line.text, label).not.toMatch(/heads-up/i);
        // Size.
        if (Math.abs(s.netBb) >= 50) expect(line.text, label).not.toMatch(/\bsmall\b|\blittle\b/i);
        if (Math.abs(s.netBb) < 300) expect(line.text, label).not.toMatch(/big day|brutal/i);
      }
    }
    expect(db.writes).toEqual([]);
  });

  it('the checker refuses the old composer\'s real output and any stat dump', async () => {
    const worst = await factsOf(DAYS[14]!); // 1684 hands, -2040.20bb
    expect(sessionLineMatches('Rough one. 1684 hands, -2040bb.', worst)).toBe(false);
    expect(sessionLineMatches('The interesting part, 5894 hands of PLO8 and -854bb down.', worst)).toBe(false);
    expect(sessionLineMatches('Down a lot of big blinds today.', worst)).toBe(false);
    expect(sessionLineMatches('Played a lot of hands and lost.', worst)).toBe(false);
    expect(sessionLineMatches('Good day at the tables.', worst)).toBe(false);
    expect(sessionLineMatches('Rough day at the no limit hold\'em tables.', worst)).toBe(true);
    const flat = await factsOf(DAYS[9]!);
    expect(sessionLineMatches('Rough day at the no limit hold\'em tables.', flat)).toBe(false);
    expect(sessionLineMatches('Booked a win in the tournaments.', flat)).toBe(false);
  });

  it('the brief carries no numbers, no units and nobody', async () => {
    const s = await factsOf(DAYS[1]!);
    const brief = briefForSpokenSession(s);
    expect(brief.amounts).toEqual([]);
    expect(brief.people).toEqual([]);
    expect(JSON.stringify(brief)).not.toMatch(/\d+\s*bb|hands/);
  });
});
