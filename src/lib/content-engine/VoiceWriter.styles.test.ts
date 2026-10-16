import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({from:vi.fn(),read:vi.fn(),update:vi.fn(),write:vi.fn()}));
vi.mock('../supabase.js',()=>({getSupabase:()=>({from:mocks.from})}));
import {syncStyleSheets} from './VoiceWriter.js';
import {styleId,styleSheetFor} from './StyleSheet.js';
import {captionVoiceProfile} from './CaptionVoice.js';

const id='2de39d61-a269-451a-9e7c-37fc1aa25ad7';
const personality=(profileId:string,version:number)=>({
  interests:['poker'],custom:{preserved:true},
  style:{style_id:styleId(styleSheetFor(profileId)),caption:{version}},
});
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.from.mockReturnValue({select:()=>({eq:()=>({maybeSingle:mocks.read})}),update:mocks.update});
 mocks.read.mockResolvedValue({data:{personality:personality(id,1)},error:null});
 mocks.update.mockReturnValue({eq:mocks.write});
 mocks.write.mockResolvedValue({error:null});
});
describe('stored caption blueprint version synchronization',()=>{
 it('updates an old caption blueprint even when the style fingerprint matches',async()=>{
  expect(await syncStyleSheets([{profile_id:id,personality:personality(id,1)}])).toEqual({checked:1,updated:1});
  expect(mocks.update).toHaveBeenCalledOnce();
  const value=mocks.update.mock.calls[0]![0].personality;
  expect(value.interests).toEqual(['poker']);
  expect(value.custom).toEqual({preserved:true});
  expect(value.style.style_id).toBe(styleId(styleSheetFor(id)));
  expect(value.style.caption).toEqual(captionVoiceProfile(styleSheetFor(id)));
 });
 it('skips an already-current supplied style and caption version without database reads',async()=>{
  const version=captionVoiceProfile(styleSheetFor(id)).version;
  expect(await syncStyleSheets([{profile_id:id,personality:personality(id,version)}])).toEqual({checked:1,updated:0});
  expect(mocks.from).not.toHaveBeenCalled();
 });
 it('rechecks the fresh row version instead of rewriting a concurrent current blueprint',async()=>{
  const version=captionVoiceProfile(styleSheetFor(id)).version;
  mocks.read.mockResolvedValue({data:{personality:personality(id,version)},error:null});
  expect(await syncStyleSheets([{profile_id:id,personality:personality(id,1)}])).toEqual({checked:1,updated:0});
  expect(mocks.read).toHaveBeenCalledOnce();
  expect(mocks.update).not.toHaveBeenCalled();
 });
 it('keeps successful updates bounded by the existing limit',async()=>{
  const ids=Array.from({length:62},(_,i)=>`horse-${i}`);
  expect(await syncStyleSheets(ids.map(profile_id=>({profile_id})))).toEqual({checked:60,updated:60});
  expect(mocks.update).toHaveBeenCalledTimes(60);
 });
 it('does not count refused writes as updated and retains the next attempt',async()=>{
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  mocks.write.mockResolvedValueOnce({error:{message:'write refused'}});
  expect(await syncStyleSheets([{profile_id:id},{profile_id:'second-horse'}],1)).toEqual({checked:2,updated:1});
  expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(warning).toHaveBeenCalledWith('[voice] style sync failed:','write refused');
  warning.mockRestore();
 });
 it.each([
  [{data:null,error:{message:'read refused'}},'read refused'],
  [{data:null,error:null},'content author not found'],
 ])('never replaces personality from an unreadable or missing row: %j',async(result,message)=>{
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  mocks.read.mockResolvedValue(result);
  expect(await syncStyleSheets([{profile_id:id,personality:personality(id,1)}])).toEqual({checked:1,updated:0});
  expect(mocks.update).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith('[voice] style sync read failed:',message);
  warning.mockRestore();
 });
});
