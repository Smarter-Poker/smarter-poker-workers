import {describe,it,expect} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {newsTitleFact} from './NewsTitleFact.js';
const fact=(title:string)=>newsTitleFact(briefForAsset({kind:'link',title,source:'PokerNews',domainHint:'poker'}));
describe('literal October23 report supply',()=>{
 it.each([
 ['Save the Dates: 2027 Irish Poker Open Runs March 18-29 in Dublin','news:schedule:irish poker open:2027'],
 ["Ignore the hangover: 2027 Irish Poker Open starts the day after St. Patrick’s Day",'news:schedule:irish poker open:2027'],
 ['Kick 2027 Off In Style at PokerStars Open Campione; New €1,250 Main Event Buy-In','news:buyin:pokerstars open campione:2027'],
 ['PokerStars cuts Campione Main Event buy-in for 2027 return','news:buyin:pokerstars open campione:2027'],
 ['Four-year chase ends in gold: Frankie Cucchiara wins first WSOP bracelet','news:bracelet:actor:frankie cucchiara:first'],
 ['Negreanu denied at Poker Masters as Nick Seward wins $412K and first PGT title','news:win:actor:nick seward:event:poker masters'],
 ['WSOP slashes Paradise rake across 12 events following criticism','news:rake:wsop paradise:12 events'],
 ])('recognizes only explicit report: %s',(title,identity)=>expect(fact(title)?.identity).toBe(identity));
 it.each(['2027 Irish Poker Open might run March 18-29 in Dublin','Save the Dates: 2028 Irish Poker Open Runs March 18-29 in Dublin','PokerStars cuts Campione Main Event buy-in for 2028 return','Frankie Cucchiara could win first WSOP bracelet','Negreanu wins $412K as Nick Seward watches','WSOP slashes Paradise rake across 99 events following criticism'])('refuses unsupported or conflicting assertion: %s',title=>expect(fact(title)).toBeNull());
});
