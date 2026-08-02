#!/usr/bin/env node
// Unit probe for the Next Event widget's bundled ICS reader.
//
// Plain node, no browser — ics.js is deliberately dependency-free so the one piece of
// this widget that can produce a WRONG ANSWER (rather than no answer) is testable
// without Playwright, and can run in CI next to bodycap-run.js.
//
// The thing under test is not "does it parse" but "does it ever lie": a recurrence it
// expands incorrectly puts a meeting on screen at a time that does not exist, which is
// worse than the honest blank it shows for rules it declines.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, Intl, Date, console };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../widgets/nextevent/ics.js'), 'utf8'), sandbox);
const ICS = sandbox.window.ICS;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' - ' + detail : ''}`);
}

const wrap = (body) => 'BEGIN:VCALENDAR\nVERSION:2.0\n' + body + '\nEND:VCALENDAR';
const ev = (lines) => wrap('BEGIN:VEVENT\n' + lines + '\nEND:VEVENT');
const DAY = 86400000;

// ---- I1 · a plain UTC event ---------------------------------------------------------
{
  const text = ev('UID:1\nDTSTART:20260810T140000Z\nSUMMARY:Standup');
  const got = ICS.next(text, Date.UTC(2026, 7, 1), 60 * DAY, {});
  check('I1 a UTC DTSTART parses to that exact instant',
    got.best && got.best.start === Date.UTC(2026, 7, 10, 14, 0, 0),
    got.best && new Date(got.best.start).toISOString());
  check('I1b and carries its summary', got.best && got.best.event.summary === 'Standup');
}

// ---- I2 · line folding --------------------------------------------------------------
{
  const text = ev('UID:2\nDTSTART:20260810T140000Z\nSUMMARY:A very long title that the\n  exporter folded');
  const got = ICS.next(text, Date.UTC(2026, 7, 1), 60 * DAY, {});
  check('I2 a folded SUMMARY is rejoined without the fold whitespace',
    got.best && got.best.event.summary === 'A very long title that the exporter folded',
    got.best && JSON.stringify(got.best.event.summary));
}

// ---- I3 · all-day -------------------------------------------------------------------
{
  const text = ev('UID:3\nDTSTART;VALUE=DATE:20260815\nSUMMARY:Holiday');
  const got = ICS.next(text, Date.UTC(2026, 7, 1), 60 * DAY, {});
  const d = new Date(got.best.start);
  check('I3 an all-day event is local midnight on its own date, not a UTC shift that '
    + 'can land it on the day before',
    got.best.event.start.allDay && d.getFullYear() === 2026 && d.getMonth() === 7 && d.getDate() === 15 && d.getHours() === 0,
    d.toString());
  const skipped = ICS.next(text, Date.UTC(2026, 7, 1), 60 * DAY, { ignoreAllDay: true });
  check('I3b and can be excluded on request', !skipped.best);
}

// ---- I4 · TZID ----------------------------------------------------------------------
{
  // 2026-08-10 09:00 in New York is 13:00 UTC (EDT, UTC-4).
  const text = ev('UID:4\nDTSTART;TZID=America/New_York:20260810T090000\nSUMMARY:Call');
  const got = ICS.next(text, Date.UTC(2026, 7, 1), 60 * DAY, {});
  check('I4 a TZID is resolved through the zone, not treated as UTC',
    got.best && got.best.start === Date.UTC(2026, 7, 10, 13, 0, 0),
    got.best && new Date(got.best.start).toISOString());
}
{
  // A winter date in the same zone is UTC-5 — the offset is looked up per instant, so
  // a fixed guess would be an hour out for half the year.
  const text = ev('UID:4b\nDTSTART;TZID=America/New_York:20260115T090000\nSUMMARY:Call');
  const got = ICS.next(text, Date.UTC(2026, 0, 1), 60 * DAY, {});
  check('I4b and the offset follows DST rather than being fixed',
    got.best && got.best.start === Date.UTC(2026, 0, 15, 14, 0, 0),
    got.best && new Date(got.best.start).toISOString());
}
{
  const text = ev('UID:4c\nDTSTART;TZID=Mars/Olympus:20260810T090000\nSUMMARY:Call');
  const got = ICS.next(text, Date.UTC(2026, 7, 1), 60 * DAY, {});
  check('I4c an unknown zone degrades to floating rather than silently meaning UTC',
    got.best && got.best.start === new Date(2026, 7, 10, 9, 0, 0).getTime(),
    got.best && new Date(got.best.start).toString());
}

// ---- I5 · DAILY ---------------------------------------------------------------------
{
  const text = ev('UID:5\nDTSTART:20260801T090000Z\nRRULE:FREQ=DAILY\nSUMMARY:Daily');
  const from = Date.UTC(2026, 7, 10, 12, 0, 0);
  const got = ICS.next(text, from, 30 * DAY, {});
  check('I5 a daily rule yields the next occurrence after `from`, not the series start',
    got.best && got.best.start === Date.UTC(2026, 7, 11, 9, 0, 0),
    got.best && new Date(got.best.start).toISOString());
}
{
  const text = ev('UID:5b\nDTSTART:20260801T090000Z\nRRULE:FREQ=DAILY;INTERVAL=3\nSUMMARY:Every third');
  // The window has to close AFTER the 09:00 occurrence on the 10th, not at midnight on
  // it — an `until` of Aug 10 00:00 legitimately excludes Aug 10 09:00, and the first
  // version of this probe failed on its own bad bound rather than on the parser.
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 11));
  check('I5b INTERVAL=3 steps three days at a time',
    hits.length === 4 && hits[1] === Date.UTC(2026, 7, 4, 9, 0, 0) && hits[3] === Date.UTC(2026, 7, 10, 9, 0, 0),
    hits.map((h) => new Date(h).toISOString().slice(0, 10)).join(','));
}

// ---- I6 · COUNT and UNTIL bound the series ------------------------------------------
{
  const text = ev('UID:6\nDTSTART:20260801T090000Z\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Three only');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1));
  check('I6 COUNT stops the series', hits.length === 3, hits.length);
  // COUNT is defined against the SERIES, so a window that opens after the series ended
  // must yield nothing — counting from `from` instead would resurrect it forever.
  const after = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 20), Date.UTC(2026, 8, 1));
  check('I6b and a finished series stays finished when the window opens later',
    after.length === 0, after.length);
}
{
  const text = ev('UID:6c\nDTSTART:20260801T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260804T090000Z\nSUMMARY:Until');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1));
  check('I6c UNTIL stops the series', hits.length === 4, hits.length);
}

// ---- I7 · WEEKLY with BYDAY ---------------------------------------------------------
{
  // 2026-08-03 is a Monday.
  const text = ev('UID:7\nDTSTART:20260803T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\nSUMMARY:MWF');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 3), Date.UTC(2026, 7, 15));
  const days = hits.map((h) => new Date(h).getUTCDay());
  check('I7 BYDAY=MO,WE,FR yields only Mondays, Wednesdays and Fridays',
    days.length > 0 && days.every((d) => d === 1 || d === 3 || d === 5),
    hits.map((h) => new Date(h).toISOString().slice(0, 10)).join(','));
  check('I7b and it produces every one of them in the window, not just the first',
    hits.length === 6, hits.length);
}

// ---- I8 · EXDATE --------------------------------------------------------------------
{
  const text = ev('UID:8\nDTSTART:20260801T090000Z\nRRULE:FREQ=DAILY\nEXDATE:20260802T090000Z\nSUMMARY:Skip one');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 4));
  check('I8 an EXDATE occurrence is removed from the series',
    !hits.includes(Date.UTC(2026, 7, 2, 9, 0, 0)) && hits.includes(Date.UTC(2026, 7, 3, 9, 0, 0)),
    hits.map((h) => new Date(h).toISOString().slice(0, 10)).join(','));
}

// ---- I9 · rules it refuses, rather than guesses -------------------------------------
{
  const text = ev('UID:9\nDTSTART:20260801T090000Z\nRRULE:FREQ=MONTHLY\nSUMMARY:Monthly');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 1), Date.UTC(2026, 11, 1));
  check('I9 an unsupported FREQ returns null (cannot expand) rather than [] (nothing '
    + 'due) or a wrong date', hits === null, JSON.stringify(hits));
  const got = ICS.next(text, Date.UTC(2026, 7, 1), 120 * DAY, {});
  check('I9b and next() counts it as dropped so the widget can say so',
    !got.best && got.dropped === 1, JSON.stringify({ best: !!got.best, dropped: got.dropped }));
}
{
  const text = ev('UID:9c\nDTSTART:20260810T140000Z\nRECURRENCE-ID:20260810T140000Z\nSUMMARY:Moved');
  const got = ICS.next(text, Date.UTC(2026, 7, 1), 60 * DAY, {});
  check('I9c a RECURRENCE-ID override is dropped, never shown at the parent time',
    !got.best && got.dropped === 1, JSON.stringify({ best: !!got.best, dropped: got.dropped }));
}

// ---- I10 · the soonest event wins across several ------------------------------------
{
  const text = wrap(
    'BEGIN:VEVENT\nUID:a\nDTSTART:20260820T090000Z\nSUMMARY:Later\nEND:VEVENT\n' +
    'BEGIN:VEVENT\nUID:b\nDTSTART:20260812T090000Z\nSUMMARY:Sooner\nEND:VEVENT\n' +
    'BEGIN:VEVENT\nUID:c\nDTSTART:20260701T090000Z\nSUMMARY:Already gone\nEND:VEVENT');
  const got = ICS.next(text, Date.UTC(2026, 7, 1), 60 * DAY, {});
  check('I10 the soonest FUTURE event wins and past ones are ignored',
    got.best && got.best.event.summary === 'Sooner',
    got.best && got.best.event.summary);
}

// ---- I11 · junk in, no crash out ----------------------------------------------------
{
  for (const junk of ['', 'not an ics at all', 'BEGIN:VEVENT\nDTSTART:garbage\nEND:VEVENT',
    'BEGIN:VEVENT\nEND:VEVENT', 'BEGIN:VEVENT\nDTSTART:20260810T140000Z']) {
    let threw = null;
    try { ICS.next(junk, Date.now(), 30 * DAY, {}); } catch (e) { threw = e; }
    check('I11 malformed input does not throw: ' + JSON.stringify(junk.slice(0, 28)), !threw, threw && threw.message);
  }
}

console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exit(failures ? 1 : 0);
