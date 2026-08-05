// Is "local midnight + 86400000" the next local midnight? Only on days that are 24h long.
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); };
const plus24h    = (ms) => startOfDay(ms) + 86400000;
const nextMidnight = (ms) => { const d = new Date(ms); d.setHours(0,0,0,0); d.setDate(d.getDate()+1); return d.getTime(); };
const show = (label, dayIso) => {
  const t = Date.parse(dayIso);
  const a = plus24h(t), b = nextMidnight(t);
  const f = (x) => new Date(x).toLocaleString('en-GB', { timeZone: process.env.TZ, hour12:false });
  console.log(`  ${label}\n    +86400000    -> ${f(a)}\n    next midnight-> ${f(b)}\n    agree: ${a === b}`);
};
console.log('TZ=' + process.env.TZ);
show('fall back (25-hour local day)', '2030-11-03T12:00:00-04:00');
show('spring forward (23-hour local day)', '2030-03-10T12:00:00-05:00');
show('an ordinary 24-hour day', '2030-06-10T12:00:00-04:00');
