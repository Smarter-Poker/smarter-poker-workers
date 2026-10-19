import {beforeEach,describe,expect,it,vi} from 'vitest';

// Only persistence boundaries are doubled. Brief parsing, six draft composition,
// style selection and canonical meaning construction execute their real code.
const ledger=vi.hoisted(()=>({
 phrase:vi.fn<(key:string,profile:string)=>Promise<'used'|'unused'|'unknown'>>(),
 semantic:vi.fn<(key:string,profile:string)=>Promise<'used'|'unused'|'unknown'>>(),
}));
vi.mock('./ContentLedger.js',async importOriginal=>({
 ...await importOriginal<typeof import('./ContentLedger.js')>(),
 phraseUseStatus:ledger.phrase,videoSemanticUseStatus:ledger.semantic,
}));
import {freshNewsCaptionCandidates,newsCandidateMeanings} from './NewsCandidateFreshness.js';

const profile='00000000-0000-0000-0000-000000000002';
const WIN='meaning:subject:news win actor nicholas palma event poker masters:news_report_context:report_context';
const GUARANTEE='meaning:subject:event apt championship guarantee 8100000:news_guarantee:guarantee_terms';
const winner={title:'Nick Palma wins Poker Masters title',url:'https://news.example/winner'};
const guarantee={title:'APT Championship $8,100,000 guaranteed',url:'https://news.example/guarantee'};
const screen=<T extends {title?:string}>(articles:readonly T[])=>freshNewsCaptionCandidates(articles,'poker','PokerNews',profile);
beforeEach(()=>{
 ledger.phrase.mockReset().mockResolvedValue('unused');
 ledger.semantic.mockReset().mockResolvedValue('unused');
});

describe('news canonical preflight before bounded artwork selection',()=>{
 it('returns no articles or ledger reads for an empty feed',async()=>{
  expect(await screen([])).toEqual({status:'ok',articles:[],scanned:0,ungroundable:0,reused:0});
  expect(ledger.phrase).not.toHaveBeenCalled();
  expect(ledger.semantic).not.toHaveBeenCalled();
 });
 it('refuses untyped, absent and question titles without reading their history',async()=>{
  const articles=[{}, {title:''},{title:'Keyboard shortcuts'},{title:'Poker Masters betting tips'},{title:'Will Nick Palma win Poker Masters title?'}];
  expect(await screen(articles)).toEqual({status:'ok',articles:[],scanned:5,ungroundable:5,reused:0});
  expect(ledger.phrase).not.toHaveBeenCalled();
  expect(ledger.semantic).not.toHaveBeenCalled();
 });
 it('constructs real canonical meanings and coalesces aliases across source, profile and URL changes',()=>{
  expect(newsCandidateMeanings(winner,'poker','PokerNews',profile)).toEqual([WIN]);
  expect(newsCandidateMeanings({title:'Nicholas Palma Scores First PGT Title At Poker Masters'},'poker','CardPlayer','00000000-0000-0000-0000-000000000003')).toEqual([WIN]);
  expect(newsCandidateMeanings({...winner,url:'https://other.example/new-upload'},'poker','PokerNews',profile)).toEqual([WIN]);
  expect(newsCandidateMeanings(guarantee,'poker','PokerNews',profile)).toEqual([GUARANTEE]);
 });
 it('keeps the original eligible article and order while separating unsupported titles',async()=>{
  expect(await screen([winner,{title:'Unknown Person wins Unknown Event'},guarantee])).toEqual({status:'ok',articles:[winner,guarantee],scanned:3,ungroundable:1,reused:0});
  expect(ledger.phrase.mock.calls).toEqual([[WIN,profile],[GUARANTEE,profile]]);
  expect(ledger.semantic.mock.calls).toEqual([[WIN,profile],[GUARANTEE,profile]]);
 });
 it.each(['phrase','semantic'] as const)('excludes a meaning used in the %s ledger even when the other ledger says unused',async boundary=>{
  ledger[boundary].mockImplementation(async key=>key===WIN?'used':'unused');
  expect(await screen([winner,guarantee])).toEqual({status:'ok',articles:[guarantee],scanned:2,ungroundable:0,reused:1});
  expect(ledger.phrase).toHaveBeenCalledWith(WIN,profile);
  expect(ledger.semantic).toHaveBeenCalledWith(WIN,profile);
 });
 it('screens equivalent source titles under one key and excludes both after one canonical use',async()=>{
  const alias={title:'Nicholas Palma Scores First PGT Title At Poker Masters'};
  ledger.semantic.mockResolvedValue('used');
  expect(await screen([winner,alias])).toEqual({status:'ok',articles:[],scanned:2,ungroundable:0,reused:2});
  expect(ledger.phrase.mock.calls).toEqual([[WIN,profile]]);
  expect(ledger.semantic.mock.calls).toEqual([[WIN,profile]]);
 });
 it.each(['phrase','semantic'] as const)('fails closed when the %s history is unknown, including another unused candidate',async boundary=>{
  ledger[boundary].mockImplementation(async key=>key===WIN?'unknown':'unused');
  const result=await screen([guarantee,winner]);
  expect(result).toEqual({status:'unknown',error:'News canonical meaning ledger unavailable'});
  expect(result).not.toHaveProperty('articles');
 });
 it.each(['phrase','semantic'] as const)('fails closed when the %s history throws',async boundary=>{
  ledger[boundary].mockRejectedValue(new Error('ledger socket unavailable'));
  expect(await screen([winner])).toEqual({status:'unknown',error:'News canonical meaning ledger unavailable'});
 });
 it('refuses more than twenty articles before any ledger reads',async()=>{
  expect(await screen(Array.from({length:21},()=>winner))).toEqual({status:'unknown',error:'News feed exceeds bounded caption preflight'});
  expect(ledger.phrase).not.toHaveBeenCalled();
  expect(ledger.semantic).not.toHaveBeenCalled();
 });
 it('allows the existing twenty-article boundary without expanding or truncating it',async()=>{
  const articles=Array.from({length:20},(_,index)=>({...winner,id:index}));
  expect(await screen(articles)).toEqual({status:'ok',articles,scanned:20,ungroundable:0,reused:0});
  expect(ledger.phrase.mock.calls).toEqual([[WIN,profile]]);
  expect(ledger.semantic.mock.calls).toEqual([[WIN,profile]]);
 });
 it('rechecks unused history on the next invocation and observes intervening publication',async()=>{
  expect(await screen([winner])).toMatchObject({status:'ok',articles:[winner]});
  ledger.semantic.mockResolvedValue('used');
  expect(await screen([winner])).toEqual({status:'ok',articles:[],scanned:1,ungroundable:0,reused:1});
  expect(ledger.phrase.mock.calls).toEqual([[WIN,profile],[WIN,profile]]);
  expect(ledger.semantic.mock.calls).toEqual([[WIN,profile],[WIN,profile]]);
 });
});
