// Independent check of zonedToUtc against EVERY DST transition in 2030, in many zones.
//
// The reference is derived from the zone data, not from the reader: RFC 5545 §3.3.5 says
// both a wall time that happens twice and one that happens not at all take the offset in
// effect BEFORE the transition, so for any affected wall time W the answer is
// W - offsetBefore. Unaffected wall times have exactly one offset and convert trivially.
const fs = require('fs'), vm = require('vm');
const load = (p) => { const s = { window: {} }; vm.createContext(s);
  new vm.Script(fs.readFileSync(p, 'utf8')).runInContext(s); return s.window.ICS; };
const which = process.argv[2] || 'widgets/nextevent/ics.js';
const ICS = load(which);

const off = (t, tz) => {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const m = {}; for (const p of dtf.formatToParts(new Date(t))) m[p.type] = p.value;
  return Date.UTC(+m.year, +m.month - 1, +m.day, (+m.hour) % 24, +m.minute, +m.second) - t;
};
// zonedToUtc is not exported; reach it through parseDate, which is.
const conv = (naiveUtcMs, tz) => {
  const d = new Date(naiveUtcMs);
  const p = (n) => String(n).padStart(2, '0');
  const v = d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
    + 'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + '00';
  const r = ICS.parseDate(v, { TZID: tz });
  return r ? r.ms : null;
};

const ZONES = ['America/New_York', 'America/Los_Angeles', 'America/Sao_Paulo', 'Europe/London',
  'Europe/Berlin', 'Europe/Dublin', 'Australia/Sydney', 'Pacific/Auckland', 'Asia/Tehran',
  'America/Santiago', 'Australia/Lord_Howe', 'Asia/Tokyo', 'Asia/Kolkata', 'UTC'];
const YEAR_START = Date.UTC(2030, 0, 1), YEAR_END = Date.UTC(2031, 0, 1);
let checks = 0, bad = 0;

for (const tz of ZONES) {
  // Find transitions by scanning hourly, then bisecting to the minute.
  const trans = [];
  let prev = off(YEAR_START, tz);
  for (let t = YEAR_START; t < YEAR_END; t += 3600000) {
    const o = off(t, tz);
    if (o !== prev) {
      let lo = t - 3600000, hi = t;
      while (hi - lo > 60000) { const mid = lo + Math.floor((hi - lo) / 2 / 60000) * 60000;
        if (mid === lo) break; (off(mid, tz) === prev ? lo = mid : hi = mid); }
      trans.push({ at: hi, before: prev, after: o });
      prev = o;
    }
  }
  for (const tr of trans) {
    const { at, before, after } = tr;
    // Wall times affected by this transition, plus controls an hour either side.
    const lo = Math.min(at + before, at + after), hi = Math.max(at + before, at + after);
    const probes = [];
    for (let w = lo; w < hi; w += 1800000) probes.push({ w, affected: true });
    probes.push({ w: lo - 3600000, affected: false }, { w: hi + 3600000, affected: false });
    for (const { w, affected } of probes) {
      const got = conv(w, tz);
      const want = affected ? w - before : w - off(w - before, tz);
      checks++;
      if (got !== want) {
        bad++;
        if (bad <= 12) console.log(`  MISMATCH ${tz} @${new Date(at).toISOString()} `
          + `(${before / 3600000}h -> ${after / 3600000}h) wall=${new Date(w).toISOString().slice(0, 16)}`
          + ` affected=${affected} got=${new Date(got).toISOString()} want=${new Date(want).toISOString()}`);
      }
    }
  }
  process.stdout.write(`  ${tz}: ${trans.length} transitions in 2030\n`);
}
console.log(`\n${which}\n  ${checks} wall times checked, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
