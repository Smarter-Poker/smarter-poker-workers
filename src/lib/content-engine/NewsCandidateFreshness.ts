import {composeCaption, RELEVANCE_FLOOR} from './Composer.js';
import {briefForAsset} from './PostBrief.js';
import {styleSheetFor} from './StyleSheet.js';
import {phraseUseStatus, videoSemanticUseStatus} from './ContentLedger.js';

export const NEWS_CANDIDATE_LIMIT=20;
type Article={title?:string};
export function newsCandidateMeanings(article:Article,topic:'poker'|'sports',source:string,profileId:string):string[]{
  const brief=briefForAsset({kind:'link',domainHint:topic,source,title:article.title??''});
  const style=styleSheetFor(profileId);
  return [...new Set(Array.from({length:6},(_,i)=>composeCaption(brief,style,String(i)))
    .filter(d=>d.text&&d.relevance>=RELEVANCE_FLOOR&&d.semanticKey?.startsWith('meaning:subject:')).map(d=>d.semanticKey!))];
}
export type FreshNewsResult<T>=
  |{status:'ok';articles:T[];scanned:number;ungroundable:number;reused:number}
  |{status:'unknown';error:string};

/** Screen the existing twenty-item feed BEFORE its three artwork slots.
 * No feed expansion, model call, caption mutation or cached unused verdict.
 * Both legacy news meanings and video meanings retain their existing reuse
 * predicates. The writer and atomic RPC still recheck at publication.
 */
export async function freshNewsCaptionCandidates<T extends Article>(articles:readonly T[],topic:'poker'|'sports',source:string,profileId:string):Promise<FreshNewsResult<T>>{
  if(articles.length>NEWS_CANDIDATE_LIMIT)return {status:'unknown',error:'News feed exceeds bounded caption preflight'};
  const candidates=articles.map(article=>({article,meanings:newsCandidateMeanings(article,topic,source,profileId)}));
  const ungroundable=candidates.filter(c=>!c.meanings.length).length;
  const keys=[...new Set(candidates.flatMap(c=>c.meanings))],used=new Set<string>();
  let next=0,unknown=false;
  try{
    // Two keys at a time, two ledger types per key: at most four SELECTs
    // concurrently. These existing existence reads already fail closed.
    await Promise.all(Array.from({length:Math.min(2,keys.length)},async()=>{
      while(!unknown&&next<keys.length){
        const key=keys[next++]!;
        const states=await Promise.all([phraseUseStatus(key,profileId),videoSemanticUseStatus(key,profileId)]);
        if(states.includes('unknown')){unknown=true;return;}
        if(states.includes('used'))used.add(key);
      }
    }));
  }catch{unknown=true;}
  if(unknown)return {status:'unknown',error:'News canonical meaning ledger unavailable'};
  const fresh=candidates.filter(c=>c.meanings.some(key=>!used.has(key))).map(c=>c.article);
  return {status:'ok',articles:fresh,scanned:articles.length,ungroundable,reused:articles.length-fresh.length-ungroundable};
}
