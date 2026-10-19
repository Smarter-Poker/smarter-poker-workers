import {describe,expect,it} from 'vitest';
import {composeCaption,hasSpecificTake} from './Composer.js';
import {briefForAsset} from './PostBrief.js';
import {styleSheetFor} from './StyleSheet.js';

describe('caption assertions require a source-established fact',()=>{
  const cases=[
    {id:'1000eabd-a6a4-4bdc-acfc-11019ce61b0c',source:'Hustler Casino Live',title:'Poker tilt',domainHint:'poker' as const},
    {id:'08fdc13e-eedc-41f6-8790-a91515e14e4f',source:'Charlie Carrel',title:'Poker tilt strategy',domainHint:'poker' as const},
    {id:'00000000-0000-4000-8000-000000000001',source:'PokerGO',title:'Tournament poker',domainHint:'poker' as const},
    {id:'1d1e1921-5ec0-4bc1-8a51-e9379301e319',source:'Mariano',title:'Poker variance',domainHint:'poker' as const},
    {id:'00000000-0000-4000-8000-000000000002',source:'PokerGO',title:'Poker cooler',domainHint:'poker' as const},
    {id:'06f7b8ff-889c-4634-b7bb-7d6c010ad8a1',source:'Bleacher Report NBA',title:'Crossover highlights',domainHint:'sports' as const},
  ];
  it('does not turn a category word into an unsupported verdict or a second repeated opinion',()=>{
    for(const row of cases){
      const b=briefForAsset({kind:'video',...row});
      for(const draft of ['0','1','2','3','4','5']){
        const out=composeCaption(b,styleSheetFor(row.id),draft);
        expect(out.text,`${row.title}/${row.id}/${draft}`).toBe('');
        expect(out.semanticKey).toBeUndefined();
      }
      expect(hasSpecificTake(b)).toBe(false);
    }
  });
  it('preserves typed source facts and their canonical freshness through retries',()=>{
    const b=briefForAsset({kind:'video',domainHint:'poker',source:'TCH Live',title:"LIVE POKER | $10/$25 No Limit Hold'em Cash Game | TCHLIVE Dallas"});
    for(const draft of ['0','1','2','3','4','5']){
      const out=composeCaption(b,styleSheetFor('0ea03648-b12d-4ae7-ba65-aeaff4fcea34'),draft);
      expect(out.text).toContain('$10/$25');
      expect(out.semanticKey).toBe('meaning:subject:stakes 10 25 unit dollars:stakes_context:effective_stacks');
    }
  });
  it('refuses the actual Kenneth, Edwin, Steven and mistargeted sports pool assertions',()=>{
    const actual=[
      {id:'1000eabd-a6a4-4bdc-acfc-11019ce61b0c',source:'Hustler Casino Live',title:'MOST TILTED Moments on HCL…But They Keep Getting Worse',domainHint:'poker' as const,concept:'tilt'},
      {id:'08fdc13e-eedc-41f6-8790-a91515e14e4f',source:'Charlie Carrel',title:'The Never Ending Downfall of Senor Tilt',domainHint:'poker' as const,concept:'tilt'},
      {id:'ffa11ad2-d258-4171-b05a-1956276a39bf',source:'PokerGO',title:'GETTING LUCKY TO WIN THE TOURNAMENT FOR $235,200?!',domainHint:'poker' as const,concept:'tournament'},
      {id:'70b5de2f-1303-49fa-a2fa-83c53e8f02b3',source:'Triton Poker',title:'Bubble Cooler! #poker #tritonpoker #shorts',domainHint:'poker' as const,concept:'cooler'},
      {id:'1d1e1921-5ec0-4bc1-8a51-e9379301e319',source:'Mariano',title:'Variance in Vegas!',domainHint:'poker' as const,concept:'variance'},
      {id:'06f7b8ff-889c-4634-b7bb-7d6c010ad8a1',source:'Bleacher Report NBA',title:'Steve Kerr says Steph tweaked his ankle and said “he’s fine” 🙏',domainHint:'sports' as const,concept:'crossover'},
      {id:'0d94b1d9-c7a6-472f-94c7-8728718c92f8',source:'NBA',title:'This Ja Morant save to Dame from the preseason was insane 🔥',domainHint:'sports' as const,concept:'save'},
    ];
    for(const row of actual){
      // The stored catalogue category/concept was an input to the failed
      // legacy path, not evidence for the claim. Keep that stale input too.
      const b={...briefForAsset({kind:'video',...row}),concepts:[row.concept]};
      for(const draft of ['0','1','2','3','4','5']){
        const out=composeCaption(b,styleSheetFor(row.id),draft);
        expect(out.text).not.toMatch(/most expensive leak|costs more than|ten minutes beats|one bad level|usually isn.t|can.t fold those|reflexes on that save|crossover like that/i);
        if(out.text)expect(out.semanticKey).toMatch(/^meaning:subject:/);
      }
    }
  });
});
