import {RANKS,rankWord} from './PokerEvaluator.js';
import {sayHolding} from './HandVoice.js';

/** Shared canonical holding parser. No caption/video module import cycle. */
export function captionHolding(value:string):{key:string;spoken:string}|null {
  const raw=value.trim().toLowerCase();
  const symbolic=raw.match(/^([akqjt2-9])[- ]?([akqjt2-9])(?: (suited|offsuit))$/);
  let notation=symbolic?`${symbolic[1]}${symbolic[2]}${symbolic[3]==='suited'?'s':'o'}`:raw.replace(/[\s-]+/g,'');
  if(!/^[akqjt2-9]{2}[so]?$/.test(notation)) {
    const words=raw.replace(/-/g,' ').split(/\s+/);
    const ranks=new Map(RANKS.map(rank=>[rankWord(rank),rank]));
    if(words.length<2||words.length>3||!ranks.has(words[0]!)||!ranks.has(words[1]!))return null;
    const suffix=words[2]==='suited'?'s':words[2]==='offsuit'?'o':words[2]?null:'';
    if(suffix===null)return null;
    notation=`${ranks.get(words[0]!)}${ranks.get(words[1]!)}${suffix}`;
  }
  const a=notation[0]!.toUpperCase(),b=notation[1]!.toUpperCase(),suffix=notation.slice(2).toLowerCase();
  if(a===b&&suffix)return null;
  const ordered=RANKS.indexOf(a as typeof RANKS[number])>=RANKS.indexOf(b as typeof RANKS[number])?`${a}${b}`:`${b}${a}`;
  const canonical=`${ordered}${suffix}`,spoken=sayHolding(canonical,'NLH');
  return spoken?{key:canonical.toLowerCase(),spoken}:null;
}
