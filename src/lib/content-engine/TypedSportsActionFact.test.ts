import {describe,it,expect} from 'vitest';
import {briefForAsset} from './PostBrief.js';
import {typedSportsActionFact} from './TypedSportsActionFact.js';

const fact=(title:string,source='NBA')=>typedSportsActionFact(briefForAsset({kind:'video',title,source,domainHint:'sports'}));
describe('typed positive sports clauses',()=>{
  it.each([
    ['Chet Holmgren Goes From BLOCK To BUCKET In Seconds 😤','typed_sports_action:block_bucket:actor:chet holmgren','Chet Holmgren goes from a block to a bucket'],
    ['Chet Holmgren BLOCKS the Shot and J-Dub THROWS IT DOWN 🔥','typed_sports_action:block_dunk:blocker:chet holmgren:dunker:jalen williams','Chet Holmgren blocks the shot and Jalen Williams dunks'],
    ['Aaron Gordon & Caleb Wilson Go Dunk for Dunk 😤💥 BACK-TO-BACK SLAMS!','typed_sports_action:paired_dunks:actors:aaron gordon:caleb wilson','Aaron Gordon and Caleb Wilson dunk'],
    ['Caleb Wilson dropped 12 points in the third quarter 🔥','typed_sports_action:quarter_points:actor:caleb wilson:points:12:quarter:3','Caleb Wilson scores 12 points in the third quarter'],
  ])('preserves literal actor roles and numbers: %s',(title,identity,subject)=>{
    expect(fact(title)).toEqual({person:'',action:'sports_technical_context',identity,subject});
  });
  it('normalizes known aliases without giving the same fact fresh identity',()=>{
    expect(fact('Luka makes half-court shots look EASY','Lakers')).toEqual({person:'',action:'sports_technical_context',identity:'typed_sports_action:half_court_makes:actor:luka doncic',subject:'Luka Doncic makes half-court shots'});
    expect(fact('Luka Doncic makes half-court shots look easy')).toEqual(fact('Luka makes half-court shots look EASY','Lakers'));
    expect(fact('"I work on those." Luka makes half-court shots look EASY #lakers','Lakers')).toEqual(fact('Luka makes half-court shots look EASY','Lakers'));
  });
  it('preserves explicitly quantified team comeback without inventing score',()=>{
    expect(fact('76ers come back from down 29 to stun the Cavs 😱','Bleacher Report NBA')).toEqual({person:'',action:'sports_technical_context',identity:'typed_sports_action:comeback:team:76ers:opponent:cavaliers:deficit:29',subject:'The 76ers come back from 29 points down against the Cavaliers'});
  });
  it('applies the same grammar to other positively known actors',()=>{
    expect(fact('LeBron James dropped 12 points in the third quarter')?.identity).toBe('typed_sports_action:quarter_points:actor:lebron james:points:12:quarter:3');
    expect(fact('Caleb Wilson & Aaron Gordon Go Dunk for Dunk BACK-TO-BACK SLAMS')?.identity).toBe('typed_sports_action:paired_dunks:actors:aaron gordon:caleb wilson');
  });
  it('never infers chronology from dunk-for-dunk wording alone',()=>{
    expect(fact('Aaron Gordon & Caleb Wilson Go Dunk for Dunk')?.subject).toBe('Aaron Gordon and Caleb Wilson dunk');
  });
  it.each([
    'Jared McCain FINDS Mara for the ALLEY-OOP SLAM',
    'Unknown Player dropped 12 points in the third quarter',
    'Chet Holmgren did not go from BLOCK To BUCKET In Seconds',
    'Can Chet Holmgren go from BLOCK To BUCKET In Seconds?',
    'Chet Holmgren Goes From BLOCK To BUCKET In Seconds and wins the title',
    'Caleb Wilson dropped 0 points in the third quarter',
    'Caleb Wilson dropped 12 points in the fifth quarter',
    '76ers INSANE comeback',
    '76ers come back from down 29 to stun the Unknowns',
    'Chet Holmgren BLOCKS the Shot and Mara THROWS IT DOWN',
  ])('refuses missing, speculative, ambiguous or unsupported facts: %s',title=>expect(fact(title)).toBeNull());
  it('refuses unqualified source and non-video content',()=>{
    expect(fact('Caleb Wilson dropped 12 points in the third quarter','Unknown Channel')).toBeNull();
    expect(typedSportsActionFact(briefForAsset({kind:'link',title:'Caleb Wilson dropped 12 points in the third quarter',source:'NBA',domainHint:'sports'}))).toBeNull();
  });
});
