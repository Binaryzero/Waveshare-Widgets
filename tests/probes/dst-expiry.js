const startOfDay=(ms)=>{const d=new Date(ms);d.setHours(0,0,0,0);return d.getTime();};
const before=(ms)=>startOfDay(ms)+86400000;
const after=(ms)=>{const d=new Date(ms);d.setHours(0,0,0,0);d.setDate(d.getDate()+1);return d.getTime();};
// An all-day event on the fall-back day: its start is that day's local midnight.
const start = startOfDay(Date.parse('2030-11-03T12:00:00-04:00'));
const f=(x)=>new Date(x).toLocaleString('en-GB',{timeZone:process.env.TZ,hour12:false});
// 23:30 local that evening — inside the hour the old arithmetic loses.
const at = Date.parse('2030-11-03T23:30:00-05:00');
console.log('  event start        :', f(start));
console.log('  expiry (pre-fix)   :', f(before(start)), '| expired at 23:30?', at > before(start));
console.log('  expiry (fixed)     :', f(after(start)),  '| expired at 23:30?', at > after(start));
