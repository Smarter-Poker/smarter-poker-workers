/**
 * The supply laws.
 *
 * Every pin here is a defect that shipped and was measured, not a rule
 * invented in advance. The measurements are 2026-09-06, on seven days of
 * live fleet output.
 */
import { describe, it, expect, vi } from 'vitest';
const clipDb = vi.hoisted(() => ({
  clips: [] as Array<Record<string, unknown>>,
  durations: [] as Array<Record<string, unknown>>,
  libraryError: false,
  libraryChunks: [] as string[][],
}));
vi.mock('../supabase.js', () => ({ getSupabase: () => ({ from: (table: string) => {
  let ids: string[] = [];
  const q: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'not', 'order', 'limit']) q[method] = () => q;
  q.in = (_column: string, values: string[]) => { ids = values; return q; };
  q.then = (resolve: (value: unknown) => void) => {
    if (table === 'video_library_videos') {
      clipDb.libraryChunks.push(ids);
      resolve({ data: clipDb.durations.filter(row => ids.includes(String(row.youtube_video_id))),
        error: clipDb.libraryError ? { message: 'duration metadata unavailable' } : null });
    } else resolve({ data: table === 'content_sources' ? [] : clipDb.clips, error: null });
  };
  return q;
} }) }));
import { sliceForHorse, sportsShareFor, SOURCES_PER_HORSE, platformCandidateClips, clipDurationSeconds, clipFormatPriority, preferShortClips } from './ClipSupply.js';
import { parseChannelFeed } from '../../routes/scrape-poker-clips.js';
import { briefForPost } from './PostBrief.js';
import { composeCaption, agentOf, anchorOf } from './Composer.js';
import { styleSheetFor } from './StyleSheet.js';
import { fleetHash } from './FleetScheduler.js';

describe('known short excerpts precede full streams without invented duration', () => {
  const clip = (id: string, url = `https://www.youtube.com/watch?v=${id}`) => ({
    id, video_id: id, source_url: url, source: 'Qualified source', title: 'Phil Ivey makes a river call', category: 'poker', oembed_ok: true,
  });
  it.each([
    ['03:00', 180], ['00:03:01', 181], ['PT2M30S', 150], ['PT1H2M3S', 3723], ['180', 180],
    ['LIVE', null], ['', null], ['00:00', null], ['2:99', null], ['-20', null], ['PT', null],
  ])('parses only an actual supported positive duration: %s', (value, expected) => {
    expect(clipDurationSeconds(value)).toBe(expected);
  });

  it('prefers known shorts at the boundary, does not trust an unknown hostname, and keeps tier order stable', () => {
    const short = { ...clip('shortvideo1'), duration_seconds: 180 };
    const long = { ...clip('longvideo01', 'https://www.youtube.com/shorts/longvideo01'), duration_seconds: 181 };
    const unknown = { ...clip('unknown0001', 'https://untrusted.example/shorts/unknown0001'), duration_seconds: null };
    expect(clipFormatPriority(short)).toBe(0);
    expect(clipFormatPriority(long)).toBe(3);
    expect(clipFormatPriority(unknown)).toBe(2);
    expect(preferShortClips([long, unknown, short, { ...unknown, id: 'another' }]).map(row => row.id))
      .toEqual([short.id, unknown.id, 'another', long.id]);
  });
  it('joins the bounded existing pool by video identity and prioritizes real short duration', async () => {
    clipDb.libraryError = false;
    clipDb.libraryChunks = [];
    clipDb.clips = [clip('longvideo01'), clip('unknown0001'), clip('shortvideo1'), clip('shortsurl01', 'https://www.youtube.com/shorts/shortsurl01')];
    clipDb.durations = [
      { youtube_video_id: 'longvideo01', duration: '02:30:00' },
      { youtube_video_id: 'shortvideo1', duration: 'PT2M30S' },
      { youtube_video_id: 'unknown0001', duration: 'LIVE' },
    ];
    const result = await platformCandidateClips('poker');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.clips.map(row => row.video_id)).toEqual(['shortvideo1', 'shortsurl01', 'unknown0001', 'longvideo01']);
    expect(result.clips[0]).toHaveProperty('duration_seconds', 150);
    expect(result.clips[1]).toHaveProperty('duration_seconds', null);
    expect(result.clips[2]).toHaveProperty('duration_seconds', null);
    expect(clipDb.libraryChunks.flat()).toHaveLength(4);
  });

  it('keeps unreadable metadata unknown and preserves every qualified asset', async () => {
    clipDb.libraryError = true;
    clipDb.libraryChunks = [];
    clipDb.clips = [clip('unknown0001'), clip('shortsurl01', 'https://www.youtube.com/shorts/shortsurl01')];
    clipDb.durations = [{ youtube_video_id: 'unknown0001', duration: '00:30' }];
    const result = await platformCandidateClips('sports');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.clips.map(row => row.video_id)).toEqual(['shortsurl01', 'unknown0001']);
    expect(result.clips.every(row => 'duration_seconds' in row && row.duration_seconds === null)).toBe(true);
    clipDb.libraryError = false;
  });

  it('bounds duration reads to chunks and does not import unrelated library rows', async () => {
    clipDb.libraryError = false;
    clipDb.libraryChunks = [];
    clipDb.clips = Array.from({ length: 205 }, (_, i) => clip(`video${String(i).padStart(6, '0')}`));
    clipDb.durations = [{ youtube_video_id: 'unrelated01', duration: '00:20' }];
    const result = await platformCandidateClips('poker');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.clips).toHaveLength(205);
    expect(clipDb.libraryChunks.map(chunk => chunk.length)).toEqual([100, 100, 5]);
    expect(result.clips.some(row => row.video_id === 'unrelated01')).toBe(false);
  });
});

function fleetIds(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = fleetHash(String(i), 'g1').toString(16).padStart(8, '0');
    const g = fleetHash(String(i), 'g2').toString(16).padStart(8, '0');
    out.push(`${h}-${g.slice(0, 4)}-4${g.slice(4, 7)}-8${h.slice(1, 4)}-${g}${h.slice(0, 4)}`);
  }
  return out;
}

describe('a horse draws from its own slice of the catalogue', () => {
  const sources = Array.from({ length: 90 }, (_, i) => `source_${i}`);
  const ids = fleetIds(200);

  it('the slice is stable for one horse and different across the fleet', () => {
    // Stability is what makes a retry produce the same post; difference is
    // what stops a thousand horses reading as one account.
    for (const id of ids.slice(0, 20)) {
      expect(sliceForHorse(sources, id)).toEqual(sliceForHorse(sources, id));
    }
    const shapes = new Set(ids.map((id) => sliceForHorse(sources, id).join('|')));
    expect(shapes.size).toBeGreaterThan(ids.length * 0.6);
  });

  it('a slice has no duplicates and is the size it claims', () => {
    for (const id of ids.slice(0, 40)) {
      const slice = sliceForHorse(sources, id);
      expect(slice).toHaveLength(SOURCES_PER_HORSE);
      expect(new Set(slice).size).toBe(slice.length);
    }
  });

  it('every source in the catalogue is reachable by somebody', () => {
    // A source no horse can draw from is a channel we scrape for nothing.
    const covered = new Set(ids.flatMap((id) => sliceForHorse(sources, id)));
    expect(covered.size).toBe(sources.length);
  });

  it('a catalogue smaller than the slice does not throw or pad', () => {
    expect(sliceForHorse(['a', 'b'], ids[0]!)).toHaveLength(2);
    expect(sliceForHorse([], ids[0]!)).toEqual([]);
  });
});

describe('how much sport a horse posts is a trait of the horse', () => {
  const ids = fleetIds(600);

  it('horses differ, and a poker platform stays poker-first', () => {
    // Phase 1-3 used one global Math.random() < 0.75, so every horse had the
    // same appetite and the mix was a property of that line rather than of
    // the characters.
    const shares = ids.map(sportsShareFor);
    expect(new Set(shares).size).toBeGreaterThan(3);
    const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
    expect(mean).toBeGreaterThan(0.08);
    expect(mean).toBeLessThan(0.18);
  });

  it('some horses are nearly pure poker and none is pure sport', () => {
    const shares = ids.map(sportsShareFor);
    expect(shares.some((s) => s <= 0.05)).toBe(true);
    expect(Math.max(...shares)).toBeLessThan(0.6);
    expect(Math.min(...shares)).toBeGreaterThan(0);
  });

  it('a horse keeps its appetite between runs', () => {
    for (const id of ids.slice(0, 30)) expect(sportsShareFor(id)).toBe(sportsShareFor(id));
  });
});

describe('a title belongs to the video it came from', () => {
  it('id and title are read from the same entry, never paired by position', () => {
    // The sports scraper this replaced regexed ids and titles out of page
    // HTML as two independent lists and paired them by index. That is where
    // "Bleacher Report NBA NBA Clip" came from, and how a brief ended up
    // naming "Keyboard" as a person.
    const xml = `<feed>
      <entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>First Video</title><published>2026-09-01T00:00:00+00:00</published></entry>
      <entry><yt:videoId>bbbbbbbbbbb</yt:videoId><title>Second Video</title><published>2026-09-02T00:00:00+00:00</published></entry>
      <entry><yt:videoId>ccccccccccc</yt:videoId><title>Third Video</title><published>2026-09-03T00:00:00+00:00</published></entry>
    </feed>`;
    const clips = parseChannelFeed(xml, 10);
    expect(clips).toHaveLength(3);
    expect(clips[0]).toMatchObject({ video_id: 'aaaaaaaaaaa', title: 'First Video' });
    expect(clips[1]).toMatchObject({ video_id: 'bbbbbbbbbbb', title: 'Second Video' });
    expect(clips[2]).toMatchObject({ video_id: 'ccccccccccc', title: 'Third Video' });
  });

  it('an entry with no title is dropped rather than given a made-up one', () => {
    // A generated title ("<Channel> <SPORT> Clip") is worse than no clip: it
    // reaches the brief as a fact about a video nobody described.
    const xml = `<feed>
      <entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>Real Title</title></entry>
      <entry><yt:videoId>bbbbbbbbbbb</yt:videoId></entry>
    </feed>`;
    const clips = parseChannelFeed(xml, 10);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.video_id).toBe('aaaaaaaaaaa');
  });

  it('XML entities in a title are decoded, not shown raw', () => {
    const xml = `<feed><entry><yt:videoId>aaaaaaaaaaa</yt:videoId>
      <title>Aces &amp; Kings &quot;All In&quot; &#39;26</title></entry></feed>`;
    expect(parseChannelFeed(xml, 5)[0]!.title).toBe(`Aces & Kings "All In" '26`);
  });
});

describe('only a named agent can be watched doing something', () => {
  const ids = fleetIds(60);

  it('a title fragment never lands in the agent slot', () => {
    // Found by reading Phase 4's own output: with real YouTube titles feeding
    // in, "DISASTER In Biggest Pot Of The Day" produced "anyone else watch
    // DISASTER do this?" and "Nobody Folds In Montreal" produced "anyone else
    // watch Nobody Folds do this?". anchorOf falls back to the key phrase,
    // and a fragment of a title cannot act.
    const titles = [
      'DISASTER In Biggest Pot Of The Day',
      'Nobody Folds In Montreal',
      'Qualifier Survives the Money Bubble',
      'Full House in Biggest Pot of the Game!',
    ];
    for (const t of titles) {
      const b = briefForPost({
        postId: 'x',
        contentType: 'video',
        mediaTitle: t,
        channel: 'World Series of Poker',
        metadata: { clip_type: 'poker' },
      });
      for (const id of ids) {
        const text = composeCaption(b, styleSheetFor(id)).text;
        const m = text.match(/watch ([^?.]+) do this/i);
        if (!m) continue;
        const named = m[1]!.trim();
        expect([...b.people, ...b.teams]).toContain(named);
      }
    }
  });

  it('agentOf is people and teams only; anchorOf may still be a topic', () => {
    const b = briefForPost({
      postId: 'x',
      contentType: 'video',
      mediaTitle: 'DISASTER In Biggest Pot Of The Day',
      channel: 'Brad Owen',
      metadata: { clip_type: 'poker' },
    });
    expect(agentOf(b)).toBeNull();
    expect(anchorOf(b)).not.toBeNull();
  });
});

describe('an instrument that cannot answer must not vote', () => {
  it('a throttled fetch is never recorded as a missing channel', async () => {
    // Measured 2026-09-06: YouTube answers a burst of channel-page requests
    // with a ~755-byte throttle page, HTTP 200. A probe that only asked "did
    // I get a string back" reported EVERY handle as missing, including
    // @LiveattheBike and @PhilHellmuth, which had resolved minutes earlier.
    // Six of those in a row retires a live channel.
    //
    // This pins the shape rather than the network: resolveChannelId reports
    // `throttled` separately from `channelId`, so the caller can tell "not
    // there" from "not answered", and only the first counts as a failure.
    const { resolveChannelId } = await import('../../routes/scrape-poker-clips.js');
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response('<html>throttled</html>', { status: 200 })) as typeof fetch;
      const r = await resolveChannelId('@AnyHandle');
      expect(r.channelId).toBeNull();
      expect(r.throttled).toBe(true);

      globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
      const missing = await resolveChannelId('@GoneForever');
      expect(missing.channelId).toBeNull();
      expect(missing.throttled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('a channel page with no channelId key still resolves via og:url', async () => {
    // @JonathanLittle is a real channel whose page carries no "channelId"
    // key at all. A resolver checking only that would have called it missing.
    const { resolveChannelId } = await import('../../routes/scrape-poker-clips.js');
    const original = globalThis.fetch;
    try {
      const page =
        '<html><head><meta property="og:url" content="https://www.youtube.com/channel/UC_o_HlX7ut2GO-IdtQSnLDg">' +
        '</head><body>' + 'x'.repeat(6000) + '</body></html>';
      globalThis.fetch = (async () => new Response(page, { status: 200 })) as typeof fetch;
      const r = await resolveChannelId('@JonathanLittle');
      expect(r.channelId).toBe('UC_o_HlX7ut2GO-IdtQSnLDg');
      expect(r.throttled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('a poker feed does not fill with slots', () => {
  it('the library import is filtered by the registry, in the query', async () => {
    // video_library_videos carries 495 slots videos across eight channels
    // that publish daily, so they dominate any "newest N" window. Reading the
    // newest 400 and filtering afterwards surfaced 21 poker videos and made
    // the bridge look finished when it had barely started. The filter belongs
    // in the query, and the names passed to it must be the ones AS STORED -
    // .in() is exact-match, so lower-cased lookup keys match nothing, quietly.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../routes/scrape-poker-clips.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain(".in('source_name', rawNames)");
    expect(src).not.toContain('[...byName.keys()]');
  });
});

describe('a real title is not turned into a claim it never made', () => {
  it('a clause title is never truncated into a different statement', async () => {
    // Phase 4 feeds real YouTube titles in, and real titles are often whole
    // sentences. The nine-word trim - fine for the hand-written noun-phrase
    // titles it was built for - turned "Daniel Negreanu is literally trying to
    // give his money away" into "...give his money", and the caption then
    // stated that as fact.
    const { topicOf } = await import('./PostBrief.js');
    expect(topicOf('Daniel Negreanu is literally trying to give his money away')).toBe(
      'Daniel Negreanu is literally trying to give his money away',
    );
    // Past a generous cap the topic is dropped rather than misquoted.
    expect(
      topicOf('This is a very long clause title that just keeps going on and on and on past any cap'),
    ).toBeUndefined();
    // A noun phrase is still trimmed - nothing that matters is lost there.
    expect(topicOf('NEVER Slow Play ACES on Television')).toBe('NEVER Slow Play ACES on Television');
  });

  it('a sentence title is stated and reacted to, never used as a noun', async () => {
    const { titleIsAClause } = await import('./Composer.js');
    const { briefForPost } = await import('./PostBrief.js');
    const { composeCaption } = await import('./Composer.js');
    const { styleSheetFor } = await import('./StyleSheet.js');

    expect(titleIsAClause('Daniel Negreanu is literally trying to give his money away')).toBe(true);
    expect(titleIsAClause('$26K on the Line')).toBe(false);

    const b = briefForPost({
      postId: 'p',
      contentType: 'video',
      mediaTitle: 'Daniel Negreanu is literally trying to give his money away',
      channel: 'PokerGO',
      metadata: { clip_type: 'poker' },
    });
    for (const id of fleetIds(40)) {
      const text = composeCaption(b, styleSheetFor(id)).text;
      // The failure shape: the title's own verb followed by the frame's verb.
      expect(text).not.toMatch(/give his money (away )?is a spot/i);
      expect(text).not.toMatch(/money is the part worth/i);
    }
  });
});
