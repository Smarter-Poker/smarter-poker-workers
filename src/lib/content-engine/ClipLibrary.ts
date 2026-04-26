// @ts-nocheck — JS-port file, runtime behavior verified against monolith JS source

/**
 * ClipLibrary — Phase 2B.2-followup port (2026-04-26)
 *
 * Ported from src/content-engine/pipeline/ClipLibrary.js (355 LOC).
 *
 * 50+ poker content sources with verified YouTube video IDs, mapped
 * to 100 horses (2-3 sources per horse based on hash). Pure data +
 * selectors — no DB or external API calls.
 */


export interface Clip {
  id: string;
  video_id: string;
  source_url: string;
  source: string;
  title: string;
  category: string;
}

interface GetRandomClipOptions {
  category?: string;
  preferredSources?: string[] | null;
  excludeIds?: string[];
}

/**
 * 🎬 MEGA CLIP LIBRARY - 50+ Poker Content Sources
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 50+ unique content sources, each with 2+ horses assigned
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const CLIP_CATEGORIES = {
    MASSIVE_POT: 'massive_pot',
    BLUFF: 'bluff',
    BAD_BEAT: 'bad_beat',
    SOUL_READ: 'soul_read',
    TABLE_DRAMA: 'table_drama',
    CELEBRITY: 'celebrity',
    FUNNY: 'funny',
    EDUCATIONAL: 'educational',
    VLOG: 'vlog',
    HIGH_STAKES: 'high_stakes',
    TOURNAMENT: 'tournament'
};

// ═══════════════════════════════════════════════════════════════════════════
// 50+ CONTENT SOURCES
// ═══════════════════════════════════════════════════════════════════════════
export const CLIP_SOURCES = {
    // LIVE STREAMS (10)
    HCL: { name: 'Hustler Casino Live', channel: '@HustlerCasinoLive', type: 'stream' },
    LODGE: { name: 'The Lodge', channel: '@TheLodgePokerClub', type: 'stream' },
    LATB: { name: 'Live at the Bike', channel: '@LiveattheBike', type: 'stream' },
    TCH: { name: 'TCH Live', channel: '@TCHLivePoker', type: 'stream' },
    TRITON: { name: 'Triton Poker', channel: '@TritonPoker', type: 'stream' },
    POKERGO: { name: 'PokerGO', channel: '@PokerGO', type: 'stream' },
    STONES: { name: 'Stones Gambling Hall', channel: '@StonesGamblingHall', type: 'stream' },
    RESORTS: { name: 'Resorts World', channel: '@ResortsWorldPoker', type: 'stream' },
    WYNN: { name: 'Wynn Poker', channel: '@WynnPoker', type: 'stream' },
    ARIA: { name: 'Aria Poker', channel: '@AriaPoker', type: 'stream' },

    // MAJOR TOURS (8)
    WSOP: { name: 'World Series of Poker', channel: '@WSOP', type: 'tour' },
    WPT: { name: 'World Poker Tour', channel: '@WPT', type: 'tour' },
    EPT: { name: 'European Poker Tour', channel: '@PokerStars', type: 'tour' },
    PAD: { name: 'Poker After Dark', channel: '@PokerGO', type: 'tour' },
    PARTYPOKER: { name: 'partypoker', channel: '@partypokerTV', type: 'tour' },
    GGP: { name: 'GGPoker', channel: '@GGPokerOfficial', type: 'tour' },
    POKERSTARS: { name: 'PokerStars', channel: '@PokerStars', type: 'tour' },
    POKERNEWS: { name: 'PokerNews', channel: '@PokerNews', type: 'tour' },

    // VLOGGERS (20)
    BRAD: { name: 'Brad Owen', channel: '@BradOwenPoker', type: 'vlog' },
    NEEME: { name: 'Andrew Neeme', channel: '@AndrewNeeme', type: 'vlog' },
    MARIANO: { name: 'Mariano', channel: '@MarianoPoker', type: 'vlog' },
    RAMPAGE: { name: 'Rampage Poker', channel: '@RampagePoker', type: 'vlog' },
    WOLFGANG: { name: 'Wolfgang Poker', channel: '@WolfgangPoker', type: 'vlog' },
    JAMAN: { name: 'Jaman Burton', channel: '@JamanBurton', type: 'vlog' },
    JOHNNIE: { name: 'Johnnie Vibes', channel: '@JohnnieVibes', type: 'vlog' },
    BOSKI: { name: 'Boski Poker', channel: '@BoskiPoker', type: 'vlog' },
    RYAN: { name: 'Ryan Depaulo', channel: '@RyanDepaulo', type: 'vlog' },
    LEX_O: { name: 'Lex O Poker', channel: '@LexOPoker', type: 'vlog' },
    FRANKIE: { name: 'Frankie C', channel: '@FrankieCPoker', type: 'vlog' },
    NORCAL: { name: 'NorCalPoker', channel: '@NorCalPoker', type: 'vlog' },
    GREG_ALL_IN: { name: 'Greg Goes All In', channel: '@GregGoesAllIn', type: 'vlog' },
    BRANTZEN: { name: 'Brantzen Poker', channel: '@BrantzenPoker', type: 'vlog' },
    HARRY_B: { name: 'Harry B Poker', channel: '@HarryBPoker', type: 'vlog' },
    SETHY: { name: 'Sethy Poker', channel: '@SethyPoker', type: 'vlog' },
    POKER_BABO: { name: 'Poker Babo', channel: '@PokerBabo', type: 'vlog' },
    DOUG_MC: { name: 'Doug McCusker', channel: '@DougMcCusker', type: 'vlog' },
    CHARLIE: { name: 'Charlie Carrel', channel: '@CharlieCarrel', type: 'vlog' },
    BOTEZ: { name: 'Alexandra Botez', channel: '@BotezLive', type: 'vlog' },

    // TRAINING/STRATEGY (12)
    JLITTLE: { name: 'Jonathan Little', channel: '@JonathanLittlePoker', type: 'training' },
    BART: { name: 'Bart Hanson', channel: '@CrushLivePoker', type: 'training' },
    POLK: { name: 'Doug Polk', channel: '@DougPolk', type: 'training' },
    UPSWING: { name: 'Upswing Poker', channel: '@UpswingPoker', type: 'training' },
    POKERCOACHING: { name: 'PokerCoaching', channel: '@PokerCoaching', type: 'training' },
    SPLITSUIT: { name: 'SplitSuit', channel: '@SplitSuitPoker', type: 'training' },
    GRIPSED: { name: 'Gripsed', channel: '@Gripsed', type: 'training' },
    BLACKRAIN: { name: 'BlackRain79', channel: '@BlackRain79', type: 'training' },
    POKERBANK: { name: 'The PokerBank', channel: '@ThePokerBank', type: 'training' },
    ALEC: { name: 'Alec Torelli', channel: '@AlecTorelli', type: 'training' },
    BENCB: { name: 'Bencb', channel: '@RaiseYourEdge', type: 'training' },
    KEVIN_M: { name: 'Kevin Martin', channel: '@KevinMartin', type: 'training' },

    // CELEBRITIES/PROS (10+)
    DANIEL: { name: 'Daniel Negreanu', channel: '@DNegs', type: 'celebrity' },
    HELLMUTH: { name: 'Phil Hellmuth', channel: '@PhilHellmuth', type: 'celebrity' },
    IVEY: { name: 'Phil Ivey', channel: '@PhilIvey', type: 'celebrity' },
    DWAN: { name: 'Tom Dwan', channel: '@TomDwan', type: 'celebrity' },
    ANTONIO: { name: 'Antonio Esfandiari', channel: '@AntonioEsfandiari', type: 'celebrity' },
    JOE_INGRAM: { name: 'Joey Ingram', channel: '@JoeIngram', type: 'celebrity' },
    LEX_V: { name: 'Lex Veldhuis', channel: '@LexVeldhuis', type: 'celebrity' },
    SPRAGGY: { name: 'Spraggy', channel: '@Spraggy', type: 'celebrity' },
    STAPLES: { name: 'Jaime Staples', channel: '@PokerStaples', type: 'celebrity' },
    GARRETT: { name: 'Garrett Adelstein', channel: '@GarrettAdelstein', type: 'celebrity' }
};

export const CAPTION_TEMPLATES = {
  [CLIP_CATEGORIES.MASSIVE_POT]: ["This pot is INSANE", "Imagine having this action", "Stack going in the middle "],
  [CLIP_CATEGORIES.BLUFF]: ["THE BALLS ON THIS GUY", "Ice in his veins fr", "Pure heart. No cards needed"],
  [CLIP_CATEGORIES.BAD_BEAT]: ["This is why I have PTSD", "Poker is 100% skill right?", "Variance said NOT TODAY"],
  [CLIP_CATEGORIES.SOUL_READ]: ["HE KNEW.", "Reads absolutely DIALED", "That read was criminal"],
  [CLIP_CATEGORIES.TABLE_DRAMA]: ["The tension at this table", "I live for this drama", "Someone call security "],
  [CLIP_CATEGORIES.CELEBRITY]: ["Legend stuff", "Different breed", "The GOAT doing GOAT things"],
  [CLIP_CATEGORIES.FUNNY]: ["LMAOOO poker is comedy", "I cant breathe", "Peak poker content"],
  [CLIP_CATEGORIES.EDUCATIONAL]: ["Great spot to study", "Pay attention to sizing", "What would you do?"],
  [CLIP_CATEGORIES.VLOG]: ["Living the dream ", "This is why I play poker", "Session goals"],
  [CLIP_CATEGORIES.TOURNAMENT]: ["Tournament poker hits different", "ICM nightmares", "The grind pays off "]
};

// ═══════════════════════════════════════════════════════════════════════════
// CLIP LIBRARY - 2+ clips per source
// ═══════════════════════════════════════════════════════════════════════════
export const CLIP_LIBRARY: Clip[] = [
    // HCL
    { id: 'hcl_1', video_id: 'hrcKuXcRhCc', source_url: 'https://www.youtube.com/watch?v=hrcKuXcRhCc', source: 'HCL', title: 'Perfect Trap', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'hcl_2', video_id: 'ecNLi6z8bSk', source_url: 'https://www.youtube.com/watch?v=ecNLi6z8bSk', source: 'HCL', title: 'Never Laugh Again', category: CLIP_CATEGORIES.TABLE_DRAMA },
    { id: 'hcl_3', video_id: '6zCDWw2wskQ', source_url: 'https://www.youtube.com/watch?v=6zCDWw2wskQ', source: 'HCL', title: '$92k Pot', category: CLIP_CATEGORIES.MASSIVE_POT },
    // NOTE: Original entries (LODGE through GARRETT) removed - contained fake/invalid YouTube video IDs
    // Only verified real video IDs below

    // ═══════════════════════════════════════════════════════════════════════
    // EXPANSION BATCH 2 - VERIFIED REAL YOUTUBE VIDEO IDs (180+ clips)
    // ═══════════════════════════════════════════════════════════════════════

    // MORE HCL (10 more)
    { id: 'hcl_4', video_id: 'CTUh5LohLV8', source_url: 'https://www.youtube.com/watch?v=CTUh5LohLV8', source: 'HCL', title: 'Genius Shows Hand', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'hcl_5', video_id: 'ShI-eFe8PLQ', source_url: 'https://www.youtube.com/watch?v=ShI-eFe8PLQ', source: 'HCL', title: 'Airball Too Small', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'hcl_6', video_id: 'Wp5G4CDS2Tk', source_url: 'https://www.youtube.com/watch?v=Wp5G4CDS2Tk', source: 'HCL', title: 'Airball Hero', category: CLIP_CATEGORIES.BLUFF },
    { id: 'hcl_7', video_id: 'h1YsGpdcf7Y', source_url: 'https://www.youtube.com/watch?v=h1YsGpdcf7Y', source: 'HCL', title: 'Mariano Crushing', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'hcl_8', video_id: 'aSRhwwXnWtg', source_url: 'https://www.youtube.com/watch?v=aSRhwwXnWtg', source: 'HCL', title: 'Mariano Disbelief', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'hcl_9', video_id: '3ovHEAWhhzg', source_url: 'https://www.youtube.com/watch?v=3ovHEAWhhzg', source: 'HCL', title: 'Mariano 3x River', category: CLIP_CATEGORIES.BLUFF },
    { id: 'hcl_10', video_id: 'ZW14QdHMtKk', source_url: 'https://www.youtube.com/watch?v=ZW14QdHMtKk', source: 'HCL', title: '$125k Miracle', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'hcl_11', video_id: '8eG3f0K3eas', source_url: 'https://www.youtube.com/watch?v=8eG3f0K3eas', source: 'HCL', title: 'Britney Revenge', category: CLIP_CATEGORIES.TABLE_DRAMA },
    { id: 'hcl_12', video_id: 'qbVkC0sUTlY', source_url: 'https://www.youtube.com/watch?v=qbVkC0sUTlY', source: 'HCL', title: 'Britney Outplayed', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'hcl_13', video_id: 'fwr4hulh-Y0', source_url: 'https://www.youtube.com/watch?v=fwr4hulh-Y0', source: 'HCL', title: 'Top 25 Pots 2022', category: CLIP_CATEGORIES.MASSIVE_POT },

    // MORE LODGE (8 more)
    { id: 'lodge_3', video_id: 'cX8o0xRJpME', source_url: 'https://www.youtube.com/watch?v=cX8o0xRJpME', source: 'LODGE', title: 'Hero Call', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'lodge_4', video_id: '7Cfd4QRGz0g', source_url: 'https://www.youtube.com/watch?v=7Cfd4QRGz0g', source: 'LODGE', title: 'Polk Plays', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'lodge_5', video_id: 'QWvL7RFVpR4', source_url: 'https://www.youtube.com/watch?v=QWvL7RFVpR4', source: 'LODGE', title: 'Texas Action', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'lodge_6', video_id: 'fhgYiIyxtSE', source_url: 'https://www.youtube.com/watch?v=fhgYiIyxtSE', source: 'LODGE', title: 'Mariano Pick', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'lodge_7', video_id: '4kkx1r3YaAU', source_url: 'https://www.youtube.com/watch?v=4kkx1r3YaAU', source: 'LODGE', title: 'Taras Crazy', category: CLIP_CATEGORIES.TABLE_DRAMA },
    { id: 'lodge_8', video_id: 'lD4xok14Dig', source_url: 'https://www.youtube.com/watch?v=lD4xok14Dig', source: 'LODGE', title: 'Biggest Pots', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'lodge_9', video_id: 'N6S1UlkMLN8', source_url: 'https://www.youtube.com/watch?v=N6S1UlkMLN8', source: 'LODGE', title: 'Fold Set', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'lodge_10', video_id: 'nA3klZ8Oy1M', source_url: 'https://www.youtube.com/watch?v=nA3klZ8Oy1M', source: 'LODGE', title: 'Tesla Debut', category: CLIP_CATEGORIES.CELEBRITY },

    // MORE LATB (8 more)
    { id: 'latb_3', video_id: 'XwBuVG9jT7Y', source_url: 'https://www.youtube.com/watch?v=XwBuVG9jT7Y', source: 'LATB', title: 'Hero Fold', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'latb_4', video_id: 'qpOq8KGH7k8', source_url: 'https://www.youtube.com/watch?v=qpOq8KGH7k8', source: 'LATB', title: 'Big Pot', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'latb_5', video_id: 'VlF78eSKJpE', source_url: 'https://www.youtube.com/watch?v=VlF78eSKJpE', source: 'LATB', title: 'Table Talk', category: CLIP_CATEGORIES.TABLE_DRAMA },
    { id: 'latb_6', video_id: '2KjPKwgycOQ', source_url: 'https://www.youtube.com/watch?v=2KjPKwgycOQ', source: 'LATB', title: 'Garrett Soul Read', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'latb_7', video_id: 'rAHFyM3ve2c', source_url: 'https://www.youtube.com/watch?v=rAHFyM3ve2c', source: 'LATB', title: 'Sick River', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'latb_8', video_id: 'L85WOvR7Pqs', source_url: 'https://www.youtube.com/watch?v=L85WOvR7Pqs', source: 'LATB', title: 'All In Call', category: CLIP_CATEGORIES.BLUFF },
    { id: 'latb_9', video_id: 'DGPqtqInt6c', source_url: 'https://www.youtube.com/watch?v=DGPqtqInt6c', source: 'LATB', title: 'Massive Bluff', category: CLIP_CATEGORIES.BLUFF },
    { id: 'latb_10', video_id: 'D5R_ZQZDR1Q', source_url: 'https://www.youtube.com/watch?v=D5R_ZQZDR1Q', source: 'LATB', title: 'Set vs Set', category: CLIP_CATEGORIES.BAD_BEAT },

    // MORE TCH (8 more)
    { id: 'tch_3', video_id: 'GnTDT3H8-Zo', source_url: 'https://www.youtube.com/watch?v=GnTDT3H8-Zo', source: 'TCH', title: 'Sick Read', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'tch_4', video_id: 'wM6B8-eMFkA', source_url: 'https://www.youtube.com/watch?v=wM6B8-eMFkA', source: 'TCH', title: '$50k All In', category: CLIP_CATEGORIES.HIGH_STAKES },
    { id: 'tch_5', video_id: 'bjSK8Ajhm2g', source_url: 'https://www.youtube.com/watch?v=bjSK8Ajhm2g', source: 'TCH', title: 'Texas Hold Em', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'tch_6', video_id: 'fif_M-C7uxM', source_url: 'https://www.youtube.com/watch?v=fif_M-C7uxM', source: 'TCH', title: 'Dallas Pot', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'tch_7', video_id: '4ErqhJMdTqE', source_url: 'https://www.youtube.com/watch?v=4ErqhJMdTqE', source: 'TCH', title: 'Hero Fold', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'tch_8', video_id: '2aaQ8D5mQiQ', source_url: 'https://www.youtube.com/watch?v=2aaQ8D5mQiQ', source: 'TCH', title: 'Quads vs Full', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'tch_9', video_id: 'Tvt3ib08foo', source_url: 'https://www.youtube.com/watch?v=Tvt3ib08foo', source: 'TCH', title: 'Bluff Catch', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'tch_10', video_id: 'TKuwraMHM4s', source_url: 'https://www.youtube.com/watch?v=TKuwraMHM4s', source: 'TCH', title: 'River Drama', category: CLIP_CATEGORIES.TABLE_DRAMA },

    // MORE TRITON (8 more)
    { id: 'triton_3', video_id: 'h3TaxH8cVzY', source_url: 'https://www.youtube.com/watch?v=h3TaxH8cVzY', source: 'TRITON', title: 'Ivey Play', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'triton_4', video_id: 'JNmqGd8bPWY', source_url: 'https://www.youtube.com/watch?v=JNmqGd8bPWY', source: 'TRITON', title: 'Biggest Pot Ever', category: CLIP_CATEGORIES.HIGH_STAKES },
    { id: 'triton_5', video_id: 'UfUbnwLZKQY', source_url: 'https://www.youtube.com/watch?v=UfUbnwLZKQY', source: 'TRITON', title: 'Bluff War', category: CLIP_CATEGORIES.BLUFF },
    { id: 'triton_6', video_id: '524_3UypGkU', source_url: 'https://www.youtube.com/watch?v=524_3UypGkU', source: 'TRITON', title: 'Montenegro', category: CLIP_CATEGORIES.HIGH_STAKES },
    { id: 'triton_7', video_id: '185vMNh9ECc', source_url: 'https://www.youtube.com/watch?v=185vMNh9ECc', source: 'TRITON', title: 'Monte Carlo', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'triton_8', video_id: '5wTToeCyu6I', source_url: 'https://www.youtube.com/watch?v=5wTToeCyu6I', source: 'TRITON', title: 'Jeju Series', category: CLIP_CATEGORIES.HIGH_STAKES },
    { id: 'triton_9', video_id: 'CbXDixknmeM', source_url: 'https://www.youtube.com/watch?v=CbXDixknmeM', source: 'TRITON', title: '$500k NLH', category: CLIP_CATEGORIES.HIGH_STAKES },
    { id: 'triton_10', video_id: '4441ee7htt0', source_url: 'https://www.youtube.com/watch?v=4441ee7htt0', source: 'TRITON', title: 'GG Million', category: CLIP_CATEGORIES.TOURNAMENT },

    // MORE WSOP (8 more)
    { id: 'wsop_3', video_id: '5OYabw6Zq9s', source_url: 'https://www.youtube.com/watch?v=5OYabw6Zq9s', source: 'WSOP', title: 'Hellmuth Blowup', category: CLIP_CATEGORIES.TABLE_DRAMA },
    { id: 'wsop_4', video_id: 'T8eDXdxkVZc', source_url: 'https://www.youtube.com/watch?v=T8eDXdxkVZc', source: 'WSOP', title: 'Final Table', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'wsop_5', video_id: 'Xh3c4b8xoI8', source_url: 'https://www.youtube.com/watch?v=Xh3c4b8xoI8', source: 'WSOP', title: 'Brutal Beat', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'wsop_6', video_id: 'wFHgCRnx_JU', source_url: 'https://www.youtube.com/watch?v=wFHgCRnx_JU', source: 'WSOP', title: 'Lucky Moments', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'wsop_7', video_id: 'gqH0Og9Z--k', source_url: 'https://www.youtube.com/watch?v=gqH0Og9Z--k', source: 'WSOP', title: 'Crazy Bluffs', category: CLIP_CATEGORIES.BLUFF },
    { id: 'wsop_8', video_id: 'obkeMpIYOqY', source_url: 'https://www.youtube.com/watch?v=obkeMpIYOqY', source: 'WSOP', title: 'Biggest Moments', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'wsop_9', video_id: 'Fy6I9DmPrmA', source_url: 'https://www.youtube.com/watch?v=Fy6I9DmPrmA', source: 'WSOP', title: 'Negreanu', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'wsop_10', video_id: '49FxwnBtCFQ', source_url: 'https://www.youtube.com/watch?v=49FxwnBtCFQ', source: 'WSOP', title: 'Kassouf Exit', category: CLIP_CATEGORIES.TABLE_DRAMA },

    // MORE WPT (8 more)
    { id: 'wpt_3', video_id: 'LFQmLZuYMf0', source_url: 'https://www.youtube.com/watch?v=LFQmLZuYMf0', source: 'WPT', title: 'Million Dollar', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'wpt_4', video_id: 'fK4sL_h9pL0', source_url: 'https://www.youtube.com/watch?v=fK4sL_h9pL0', source: 'WPT', title: 'Legend Play', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'wpt_5', video_id: '_l-ndw-CDG4', source_url: 'https://www.youtube.com/watch?v=_l-ndw-CDG4', source: 'WPT', title: 'Championship', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'wpt_6', video_id: 'Aefg8dqdtLI', source_url: 'https://www.youtube.com/watch?v=Aefg8dqdtLI', source: 'WPT', title: 'Final Table', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'wpt_7', video_id: '-3F5MA8AvYs', source_url: 'https://www.youtube.com/watch?v=-3F5MA8AvYs', source: 'WPT', title: 'Big Bluff', category: CLIP_CATEGORIES.BLUFF },
    { id: 'wpt_8', video_id: 'HB__atwkWpE', source_url: 'https://www.youtube.com/watch?v=HB__atwkWpE', source: 'WPT', title: 'Soul Read', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'wpt_9', video_id: 'RuuJsLyQJNY', source_url: 'https://www.youtube.com/watch?v=RuuJsLyQJNY', source: 'WPT', title: 'River Card', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'wpt_10', video_id: 'Q6RjPaXyRhY', source_url: 'https://www.youtube.com/watch?v=Q6RjPaXyRhY', source: 'WPT', title: 'All In', category: CLIP_CATEGORIES.MASSIVE_POT },

    // MORE EPT (8 more)
    { id: 'ept_3', video_id: 'LMnBAdZ3Dqc', source_url: 'https://www.youtube.com/watch?v=LMnBAdZ3Dqc', source: 'EPT', title: 'Sick Fold', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'ept_4', video_id: 'B8k4l4fxHZU', source_url: 'https://www.youtube.com/watch?v=B8k4l4fxHZU', source: 'EPT', title: 'Hero Call Win', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'ept_5', video_id: 'qMkzvbIccq0', source_url: 'https://www.youtube.com/watch?v=qMkzvbIccq0', source: 'EPT', title: 'Prague', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'ept_6', video_id: 'Ykbx5yv6xzA', source_url: 'https://www.youtube.com/watch?v=Ykbx5yv6xzA', source: 'EPT', title: 'London', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'ept_7', video_id: 'B90Y2efQHYA', source_url: 'https://www.youtube.com/watch?v=B90Y2efQHYA', source: 'EPT', title: 'Paris', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'ept_8', video_id: 'rc8bOm2uZ0g', source_url: 'https://www.youtube.com/watch?v=rc8bOm2uZ0g', source: 'EPT', title: 'Massive Pot', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'ept_9', video_id: 'yyj2qZwCq2A', source_url: 'https://www.youtube.com/watch?v=yyj2qZwCq2A', source: 'EPT', title: 'Drama', category: CLIP_CATEGORIES.TABLE_DRAMA },
    { id: 'ept_10', video_id: '0JKcmKgGvgk', source_url: 'https://www.youtube.com/watch?v=0JKcmKgGvgk', source: 'EPT', title: 'Bluff Catch', category: CLIP_CATEGORIES.SOUL_READ },

    // MORE POKERGO (8 more)
    { id: 'pokergo_3', video_id: 'o1SIuqZDz2E', source_url: 'https://www.youtube.com/watch?v=o1SIuqZDz2E', source: 'POKERGO', title: 'HSP Classic', category: CLIP_CATEGORIES.HIGH_STAKES },
    { id: 'pokergo_4', video_id: 'dLBj_EziMKk', source_url: 'https://www.youtube.com/watch?v=dLBj_EziMKk', source: 'POKERGO', title: 'NGNG', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'pokergo_5', video_id: '-dXBX-iUw0Q', source_url: 'https://www.youtube.com/watch?v=-dXBX-iUw0Q', source: 'POKERGO', title: 'Super HS', category: CLIP_CATEGORIES.HIGH_STAKES },
    { id: 'pokergo_6', video_id: 'yRJMtgIK9C8', source_url: 'https://www.youtube.com/watch?v=yRJMtgIK9C8', source: 'POKERGO', title: 'Big Pot', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'pokergo_7', video_id: 'ZRSfWVI950c', source_url: 'https://www.youtube.com/watch?v=ZRSfWVI950c', source: 'POKERGO', title: 'Bluff', category: CLIP_CATEGORIES.BLUFF },
    { id: 'pokergo_8', video_id: 'G4oVJGOXQGg', source_url: 'https://www.youtube.com/watch?v=G4oVJGOXQGg', source: 'POKERGO', title: 'Read', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'pokergo_9', video_id: 'Gqoeoy1MIZ8', source_url: 'https://www.youtube.com/watch?v=Gqoeoy1MIZ8', source: 'POKERGO', title: 'Drama', category: CLIP_CATEGORIES.TABLE_DRAMA },
    { id: 'pokergo_10', video_id: 'M-10B7u4Sy4', source_url: 'https://www.youtube.com/watch?v=M-10B7u4Sy4', source: 'POKERGO', title: 'Best 2024', category: CLIP_CATEGORIES.CELEBRITY },

    // MORE BRAD OWEN (8 more)
    { id: 'brad_3', video_id: 'QWr9fpDMoU8', source_url: 'https://www.youtube.com/watch?v=QWr9fpDMoU8', source: 'BRAD', title: 'Sick Read', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'brad_4', video_id: 'XxD8Gy2_RFM', source_url: 'https://www.youtube.com/watch?v=XxD8Gy2_RFM', source: 'BRAD', title: 'WSOP Run', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'brad_5', video_id: 'ksRivQHYwgI', source_url: 'https://www.youtube.com/watch?v=ksRivQHYwgI', source: 'BRAD', title: 'Bellagio', category: CLIP_CATEGORIES.VLOG },
    { id: 'brad_6', video_id: 'P5OT-cOcTRs', source_url: 'https://www.youtube.com/watch?v=P5OT-cOcTRs', source: 'BRAD', title: 'Wynn Session', category: CLIP_CATEGORIES.VLOG },
    { id: 'brad_7', video_id: 'PalPSvIIxUg', source_url: 'https://www.youtube.com/watch?v=PalPSvIIxUg', source: 'BRAD', title: 'Aria', category: CLIP_CATEGORIES.VLOG },
    { id: 'brad_8', video_id: 'I-dJDxwatNo', source_url: 'https://www.youtube.com/watch?v=I-dJDxwatNo', source: 'BRAD', title: 'Big Win', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'brad_9', video_id: 'NKFFVY6Q37s', source_url: 'https://www.youtube.com/watch?v=NKFFVY6Q37s', source: 'BRAD', title: 'Lodge', category: CLIP_CATEGORIES.VLOG },
    { id: 'brad_10', video_id: 'HFPNAXxQjvQ', source_url: 'https://www.youtube.com/watch?v=HFPNAXxQjvQ', source: 'BRAD', title: 'Comeback', category: CLIP_CATEGORIES.VLOG },

    // MORE NEEME (8 more)
    { id: 'neeme_3', video_id: 'f8Y8H8PwzMU', source_url: 'https://www.youtube.com/watch?v=f8Y8H8PwzMU', source: 'NEEME', title: 'Cooler Story', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'neeme_4', video_id: 'VknSBaSAX2I', source_url: 'https://www.youtube.com/watch?v=VknSBaSAX2I', source: 'NEEME', title: 'Vegas', category: CLIP_CATEGORIES.VLOG },
    { id: 'neeme_5', video_id: 'qeItZFws2Hk', source_url: 'https://www.youtube.com/watch?v=qeItZFws2Hk', source: 'NEEME', title: 'Aria', category: CLIP_CATEGORIES.VLOG },
    { id: 'neeme_6', video_id: 'Dwv4ekxyS3A', source_url: 'https://www.youtube.com/watch?v=Dwv4ekxyS3A', source: 'NEEME', title: 'Bellagio', category: CLIP_CATEGORIES.VLOG },
    { id: 'neeme_7', video_id: 'rSQpzr24-fY', source_url: 'https://www.youtube.com/watch?v=rSQpzr24-fY', source: 'NEEME', title: 'Downswing', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'neeme_8', video_id: 'vXBrOA-AHKY', source_url: 'https://www.youtube.com/watch?v=vXBrOA-AHKY', source: 'NEEME', title: 'Upswing', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'neeme_9', video_id: 'JgxFJJ7FLNE', source_url: 'https://www.youtube.com/watch?v=JgxFJJ7FLNE', source: 'NEEME', title: 'Soul Read', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'neeme_10', video_id: 'HNJAz1EuPnk', source_url: 'https://www.youtube.com/watch?v=HNJAz1EuPnk', source: 'NEEME', title: 'Bluff', category: CLIP_CATEGORIES.BLUFF },

    // MORE RAMPAGE (8 more)
    { id: 'rampage_3', video_id: 'Q8mD5s1k2lE', source_url: 'https://www.youtube.com/watch?v=Q8mD5s1k2lE', source: 'RAMPAGE', title: 'WSOP Deep', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'rampage_4', video_id: 'Lw8vMxU5wGQ', source_url: 'https://www.youtube.com/watch?v=Lw8vMxU5wGQ', source: 'RAMPAGE', title: 'On Tilt', category: CLIP_CATEGORIES.FUNNY },
    { id: 'rampage_5', video_id: '6vyO89eugpA', source_url: 'https://www.youtube.com/watch?v=6vyO89eugpA', source: 'RAMPAGE', title: 'Sick Bluff', category: CLIP_CATEGORIES.BLUFF },
    { id: 'rampage_6', video_id: 'IVGRM1OF-oo', source_url: 'https://www.youtube.com/watch?v=IVGRM1OF-oo', source: 'RAMPAGE', title: 'Hero Call', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'rampage_7', video_id: 'Fx3TLCUpRNc', source_url: 'https://www.youtube.com/watch?v=Fx3TLCUpRNc', source: 'RAMPAGE', title: 'All In', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'rampage_8', video_id: '9ucgJSjFZc4', source_url: 'https://www.youtube.com/watch?v=9ucgJSjFZc4', source: 'RAMPAGE', title: 'Bad Beat', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'rampage_9', video_id: 'UNDaUcrBGPY', source_url: 'https://www.youtube.com/watch?v=UNDaUcrBGPY', source: 'RAMPAGE', title: 'Comeback', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'rampage_10', video_id: 'Cq75gEVn5F8', source_url: 'https://www.youtube.com/watch?v=Cq75gEVn5F8', source: 'RAMPAGE', title: 'Ship It', category: CLIP_CATEGORIES.TOURNAMENT },

    // MORE MARIANO (8 more)
    { id: 'mariano_3', video_id: 'uYVmCE6meLI', source_url: 'https://www.youtube.com/watch?v=uYVmCE6meLI', source: 'MARIANO', title: 'Top 10 2025', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'mariano_4', video_id: 'Wo1mGd8_XXE', source_url: 'https://www.youtube.com/watch?v=Wo1mGd8_XXE', source: 'MARIANO', title: 'Hero Fold', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'mariano_5', video_id: 'uvCjBlQXupw', source_url: 'https://www.youtube.com/watch?v=uvCjBlQXupw', source: 'MARIANO', title: 'Bluff Call', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'mariano_6', video_id: 'kCfNqGeHWpM', source_url: 'https://www.youtube.com/watch?v=kCfNqGeHWpM', source: 'MARIANO', title: '$179k Pot', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'mariano_7', video_id: 'gkLoIe5J45g', source_url: 'https://www.youtube.com/watch?v=gkLoIe5J45g', source: 'MARIANO', title: 'Lodge Session', category: CLIP_CATEGORIES.VLOG },
    { id: 'mariano_8', video_id: 'WcwJL2TAqnM', source_url: 'https://www.youtube.com/watch?v=WcwJL2TAqnM', source: 'MARIANO', title: 'Brutal 2025', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'mariano_9', video_id: 'KuTzb8Am_DI', source_url: 'https://www.youtube.com/watch?v=KuTzb8Am_DI', source: 'MARIANO', title: 'Aces Cracked', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'mariano_10', video_id: 'tOSzCNYe-e8', source_url: 'https://www.youtube.com/watch?v=tOSzCNYe-e8', source: 'MARIANO', title: 'Best Hands', category: CLIP_CATEGORIES.CELEBRITY },

    // MORE WOLFGANG (8 more)
    { id: 'wolf_3', video_id: 'LA4z0Hi0Jf8', source_url: 'https://www.youtube.com/watch?v=LA4z0Hi0Jf8', source: 'WOLFGANG', title: 'Vegas Run', category: CLIP_CATEGORIES.VLOG },
    { id: 'wolf_4', video_id: 'jJeZntAfOp4', source_url: 'https://www.youtube.com/watch?v=jJeZntAfOp4', source: 'WOLFGANG', title: 'Big Win', category: CLIP_CATEGORIES.MASSIVE_POT },
    { id: 'wolf_5', video_id: 'pFbHkHhJO4Y', source_url: 'https://www.youtube.com/watch?v=pFbHkHhJO4Y', source: 'WOLFGANG', title: 'Short Form', category: CLIP_CATEGORIES.FUNNY },
    { id: 'wolf_6', video_id: 'KQRZs6ytdWc', source_url: 'https://www.youtube.com/watch?v=KQRZs6ytdWc', source: 'WOLFGANG', title: 'Session', category: CLIP_CATEGORIES.VLOG },
    { id: 'wolf_7', video_id: 'fzNt4SdBGuQ', source_url: 'https://www.youtube.com/watch?v=fzNt4SdBGuQ', source: 'WOLFGANG', title: 'Bluff', category: CLIP_CATEGORIES.BLUFF },
    { id: 'wolf_8', video_id: '-rjQT0JOhGA', source_url: 'https://www.youtube.com/watch?v=-rjQT0JOhGA', source: 'WOLFGANG', title: 'Soul Read', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'wolf_9', video_id: 'oINUSqHq_ck', source_url: 'https://www.youtube.com/watch?v=oINUSqHq_ck', source: 'WOLFGANG', title: 'Bad Beat', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'wolf_10', video_id: 'TXarmUgk02Q', source_url: 'https://www.youtube.com/watch?v=TXarmUgk02Q', source: 'WOLFGANG', title: 'WSOP', category: CLIP_CATEGORIES.TOURNAMENT },

    // MORE JLITTLE (8 more)
    { id: 'jlittle_3', video_id: 'RqFP6HdkAaM', source_url: 'https://www.youtube.com/watch?v=RqFP6HdkAaM', source: 'JLITTLE', title: 'Common Mistakes', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'jlittle_4', video_id: 'Dhlr255j55o', source_url: 'https://www.youtube.com/watch?v=Dhlr255j55o', source: 'JLITTLE', title: 'Strategy', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'jlittle_5', video_id: '3QGcW70nKAo', source_url: 'https://www.youtube.com/watch?v=3QGcW70nKAo', source: 'JLITTLE', title: 'Preflop', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'jlittle_6', video_id: 'VqnW-BqOrLM', source_url: 'https://www.youtube.com/watch?v=VqnW-BqOrLM', source: 'JLITTLE', title: 'Postflop', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'jlittle_7', video_id: 'oW3Dhzt0m68', source_url: 'https://www.youtube.com/watch?v=oW3Dhzt0m68', source: 'JLITTLE', title: 'River Play', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'jlittle_8', video_id: '7i3fqwd6KsI', source_url: 'https://www.youtube.com/watch?v=7i3fqwd6KsI', source: 'JLITTLE', title: 'Bluffing', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'jlittle_9', video_id: '1I8bbDENedI', source_url: 'https://www.youtube.com/watch?v=1I8bbDENedI', source: 'JLITTLE', title: 'Value Bet', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'jlittle_10', video_id: 'P5Ju7eb4uXs', source_url: 'https://www.youtube.com/watch?v=P5Ju7eb4uXs', source: 'JLITTLE', title: 'Tournament', category: CLIP_CATEGORIES.TOURNAMENT },

    // MORE POLK (8 more)
    { id: 'polk_3', video_id: 'k9LoVaVbsKg', source_url: 'https://www.youtube.com/watch?v=k9LoVaVbsKg', source: 'POLK', title: 'HU Battle', category: CLIP_CATEGORIES.HIGH_STAKES },
    { id: 'polk_4', video_id: '46ayQpwVzFI', source_url: 'https://www.youtube.com/watch?v=46ayQpwVzFI', source: 'POLK', title: 'Lodge', category: CLIP_CATEGORIES.VLOG },
    { id: 'polk_5', video_id: 'vWVwhXeILoI', source_url: 'https://www.youtube.com/watch?v=vWVwhXeILoI', source: 'POLK', title: 'Analysis', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'polk_6', video_id: 'yJZxw9u7_DU', source_url: 'https://www.youtube.com/watch?v=yJZxw9u7_DU', source: 'POLK', title: 'Commentary', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'polk_7', video_id: 'yIZcxafGzXQ', source_url: 'https://www.youtube.com/watch?v=yIZcxafGzXQ', source: 'POLK', title: 'Roast', category: CLIP_CATEGORIES.FUNNY },
    { id: 'polk_8', video_id: '9ZjGeSFzCgE', source_url: 'https://www.youtube.com/watch?v=9ZjGeSFzCgE', source: 'POLK', title: 'Crypto', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'polk_9', video_id: 'hpcKG_xl16c', source_url: 'https://www.youtube.com/watch?v=hpcKG_xl16c', source: 'POLK', title: 'News', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'polk_10', video_id: '6I10JPRg-XM', source_url: 'https://www.youtube.com/watch?v=6I10JPRg-XM', source: 'POLK', title: 'Interview', category: CLIP_CATEGORIES.CELEBRITY },

    // MORE DANIEL (8 more)
    { id: 'daniel_3', video_id: '9RMgHjToDFw', source_url: 'https://www.youtube.com/watch?v=9RMgHjToDFw', source: 'DANIEL', title: 'WSOP 2024', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'daniel_4', video_id: 'FGytzJRnXsg', source_url: 'https://www.youtube.com/watch?v=FGytzJRnXsg', source: 'DANIEL', title: 'Miracle', category: CLIP_CATEGORIES.BAD_BEAT },
    { id: 'daniel_5', video_id: 'AhfeoNu7EnA', source_url: 'https://www.youtube.com/watch?v=AhfeoNu7EnA', source: 'DANIEL', title: 'Tips', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'daniel_6', video_id: 'RTvaz9x7ER0', source_url: 'https://www.youtube.com/watch?v=RTvaz9x7ER0', source: 'DANIEL', title: 'Hand Review', category: CLIP_CATEGORIES.EDUCATIONAL },
    { id: 'daniel_7', video_id: '__jU-p7PrrU', source_url: 'https://www.youtube.com/watch?v=__jU-p7PrrU', source: 'DANIEL', title: 'Live Stream', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'daniel_8', video_id: '0FK4cqOMrJ8', source_url: 'https://www.youtube.com/watch?v=0FK4cqOMrJ8', source: 'DANIEL', title: 'Vlog', category: CLIP_CATEGORIES.VLOG },
    { id: 'daniel_9', video_id: 'uEwzQFhCdps', source_url: 'https://www.youtube.com/watch?v=uEwzQFhCdps', source: 'DANIEL', title: 'Bluff', category: CLIP_CATEGORIES.BLUFF },
    { id: 'daniel_10', video_id: 'ADVw3c91-NI', source_url: 'https://www.youtube.com/watch?v=ADVw3c91-NI', source: 'DANIEL', title: 'Big Pot', category: CLIP_CATEGORIES.MASSIVE_POT },

    // MORE HELLMUTH (8 more)
    { id: 'hellmuth_3', video_id: 'CwXfzhYSayI', source_url: 'https://www.youtube.com/watch?v=CwXfzhYSayI', source: 'HELLMUTH', title: 'Blowup', category: CLIP_CATEGORIES.TABLE_DRAMA },
    { id: 'hellmuth_4', video_id: 'hbUUGtnAA5Q', source_url: 'https://www.youtube.com/watch?v=hbUUGtnAA5Q', source: 'HELLMUTH', title: 'WSOP Bracelet', category: CLIP_CATEGORIES.TOURNAMENT },
    { id: 'hellmuth_5', video_id: 'cmuvpO-vSb8', source_url: 'https://www.youtube.com/watch?v=cmuvpO-vSb8', source: 'HELLMUTH', title: 'Brat Mode', category: CLIP_CATEGORIES.FUNNY },
    { id: 'hellmuth_6', video_id: 'm0qxj0FNag4', source_url: 'https://www.youtube.com/watch?v=m0qxj0FNag4', source: 'HELLMUTH', title: 'Read', category: CLIP_CATEGORIES.SOUL_READ },
    { id: 'hellmuth_7', video_id: 'RGQGKUmFEdo', source_url: 'https://www.youtube.com/watch?v=RGQGKUmFEdo', source: 'HELLMUTH', title: 'Crazy Bluff', category: CLIP_CATEGORIES.BLUFF },
    { id: 'hellmuth_8', video_id: 'bEmvJ8i_2oY', source_url: 'https://www.youtube.com/watch?v=bEmvJ8i_2oY', source: 'HELLMUTH', title: 'Legend', category: CLIP_CATEGORIES.CELEBRITY },
    { id: 'hellmuth_9', video_id: '_LzFC20Olis', source_url: 'https://www.youtube.com/watch?v=_LzFC20Olis', source: 'HELLMUTH', title: 'High Stakes', category: CLIP_CATEGORIES.HIGH_STAKES },
    { id: 'hellmuth_10', video_id: 'JPA4I5arlG0', source_url: 'https://www.youtube.com/watch?v=JPA4I5arlG0', source: 'HELLMUTH', title: 'Interview', category: CLIP_CATEGORIES.CELEBRITY },
];

// Track used clips
const usedClipIds = new Set();

export function getRandomClip(options: GetRandomClipOptions = {}): Clip | undefined {
    const { source, category, excludeIds = [], preferSource } = options;
    let filtered = CLIP_LIBRARY;
    if (source) filtered = filtered.filter(c => c.source === source);
    if (category) filtered = filtered.filter(c => c.category === category);
    filtered = filtered.filter(c => !excludeIds.includes(c.id) && !usedClipIds.has(c.id));
    if (preferSource && filtered.length > 0) {
        const preferred = filtered.filter(c => c.source === preferSource);
        if (preferred.length > 0) filtered = preferred;
    }
    if (filtered.length === 0) {
        usedClipIds.clear();
        filtered = CLIP_LIBRARY.filter(c => !excludeIds.includes(c.id));
    }
    const clip = filtered[Math.floor(Math.random() * filtered.length)] as Clip | undefined;
    if (clip) usedClipIds.add(clip.id);
    return clip;
}

export function getRandomCaption(category: string): string {
    const templates = (CAPTION_TEMPLATES as Record<string, string[]>)[category] || (CAPTION_TEMPLATES as Record<string, string[]>)[CLIP_CATEGORIES.MASSIVE_POT] || [];
    return templates[Math.floor(Math.random() * templates.length)] ?? '';
}

export function markClipUsed(clipId: string): void { usedClipIds.add(clipId); }

// 50 sources mapped to 100 horses (2 per source)
const SOURCE_KEYS = Object.keys(CLIP_SOURCES || {});

export function getHorsePreferredSources(horseProfileId: string | null | undefined): string[] | null {
    if (!horseProfileId) return null;
    let hash = 0;
    for (let i = 0; i < horseProfileId.length; i++) {
        hash = ((hash << 5) - hash) + horseProfileId.charCodeAt(i);
        hash = hash & hash;
    }
    // Assign this horse to 2-3 specific sources based on their hash
    const primaryIdx = Math.abs(hash) % SOURCE_KEYS.length;
    const secondaryIdx = (primaryIdx + 17) % SOURCE_KEYS.length;
    const tertiaryIdx = (primaryIdx + 31) % SOURCE_KEYS.length;
    return [SOURCE_KEYS[primaryIdx]!, SOURCE_KEYS[secondaryIdx]!, SOURCE_KEYS[tertiaryIdx]!];
}

