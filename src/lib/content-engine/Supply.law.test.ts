/**
 * The supply laws.
 *
 * Every pin here is a defect that shipped and was measured, not a rule
 * invented in advance. The measurements are 2026-09-06, on seven days of
 * live fleet output.
 */
import { describe, it, expect } from 'vitest';
import { sliceForHorse, sportsShareFor, SOURCES_PER_HORSE } from './ClipSupply.js';
import { parseChannelFeed } from '../../routes/scrape-poker-clips.js';
import { briefForPost } from './PostBrief.js';
import { composeCaption, agentOf, anchorOf } from './Composer.js';
import { styleSheetFor } from './StyleSheet.js';
import { fleetHash } from './FleetScheduler.js';

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

  it('horses differ, and the fleet still averages near a quarter', () => {
    // Phase 1-3 used one global Math.random() < 0.75, so every horse had the
    // same appetite and the mix was a property of that line rather than of
    // the characters.
    const shares = ids.map(sportsShareFor);
    expect(new Set(shares).size).toBeGreaterThan(3);
    const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
    expect(mean).toBeGreaterThan(0.15);
    expect(mean).toBeLessThan(0.35);
  });

  it('some horses are nearly pure poker and none is pure sport', () => {
    const shares = ids.map(sportsShareFor);
    expect(shares.some((s) => s <= 0.05)).toBe(true);
    expect(Math.max(...shares)).toBeLessThan(0.8);
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
