import {it,expect} from 'vitest';
import {render,styleSheetFor} from './StyleSheet.js';
it('preserves currency amounts and literal labels under words numeral voice',()=>{
 const style={...styleSheetFor('currency-regression'),numerals:'words' as const,casing:'sentence' as const,opener:'none' as const,closer:'none' as const};
 const text=render(['€1,250 and £2,500 and $3,000, Event #7 Day 2, 3-0 at 12:30, As Kd'],style,'currency');
 for(const literal of ['€1,250','£2,500','$3,000','Event #7','Day 2','3-0','12:30','As Kd'])expect(text).toContain(literal);
});
