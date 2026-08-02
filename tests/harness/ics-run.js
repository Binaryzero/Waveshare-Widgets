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
  const text = ev('UID:9d\nDTSTART:20260801T090000Z\nRRULE:FREQ=DAILY;BYMONTHDAY=15\nSUMMARY:Fifteenth');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 6));
  check('I9d a SUPPORTED freq with an unsupported CONSTRAINT is refused, not expanded '
    + 'as if the constraint were absent — ignoring BYMONTHDAY turns "the 15th" into '
    + '"every day"', hits === null, JSON.stringify(hits));
}
{
  const text = ev('UID:9e\nDTSTART:20260801T090000Z\nRRULE:FREQ=DAILY;BYSETPOS=1\nSUMMARY:Setpos');
  check('I9e and so is BYSETPOS', ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 6)) === null);
}

// ---- I12 · a long-running series must not fall off the guard ------------------------
// A daily standup running since 2020 needs ~2,400 steps from DTSTART to reach today.
// Walking from DTSTART with a fixed guard gave up before arriving and returned [] with
// dropped 0 — the event vanished while the widget said the calendar was empty, which is
// the same lie as a wrong time wearing a different hat.
{
  const text = ev('UID:12\nDTSTART:20200101T090000Z\nRRULE:FREQ=DAILY\nSUMMARY:Ancient standup');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 5));
  check('I12 a daily series running since 2020 still yields its current occurrences',
    hits.length === 4 && hits[0] === Date.UTC(2026, 7, 1, 9, 0, 0),
    hits.length + ' — ' + hits.map((h) => new Date(h).toISOString().slice(0, 10)).join(','));
}
{
  // COUNT must still be honored from the series start, so the fast-forward may not
  // apply to a counted rule — a finished counted series must stay finished.
  const text = ev('UID:12b\nDTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;COUNT=5\nSUMMARY:Five in 2020');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 5));
  check('I12b and a COUNT series that finished in 2020 stays finished', hits.length === 0, hits.length);
}

// ---- I13 · DST: the wall clock is what recurs, not the elapsed milliseconds ----------
// Adding 86,400,000 ms is only "the same time tomorrow" where a day is 24h. A 09:00
// New York daily event stepped that way reads 10:00 from the March transition until
// November — a meeting displayed at a time it does not happen.
{
  const text = ev('UID:13\nDTSTART;TZID=America/New_York:20260307T090000\nRRULE:FREQ=DAILY\nSUMMARY:Daily NY');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 11));
  const local = hits.map((h) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(h)));
  check('I13 a TZID daily event holds its wall-clock time across a DST transition',
    local.length >= 4 && local.every((t) => t === '09:00'), local.join(' | '));
}
{
  // Floating times are local wall clock by definition and must behave the same way.
  const text = ev('UID:13b\nDTSTART:20260307T090000\nRRULE:FREQ=DAILY\nSUMMARY:Daily floating');
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 2, 7), Date.UTC(2026, 2, 12));
  check('I13b and so does a floating one',
    hits.every((h) => new Date(h).getHours() === 9),
    hits.map((h) => new Date(h).getHours()).join(','));
}

// ---- I14 · an override moves its occurrence, it does not duplicate or vanish ---------
// A real export carries BOTH the recurring parent and a RECURRENCE-ID child for the
// moved instance. The earlier version of this probe supplied the child ALONE, so it
// passed while the parent — the half that actually shows the wrong time — went
// untested. With both present the old slot must be gone and the new one shown.
{
  const text = wrap(
    'BEGIN:VEVENT\nUID:p\nDTSTART:20260803T090000Z\nRRULE:FREQ=DAILY\nSUMMARY:Standup\nEND:VEVENT\n' +
    'BEGIN:VEVENT\nUID:p\nRECURRENCE-ID:20260804T090000Z\nDTSTART:20260804T140000Z\nSUMMARY:Standup moved\nEND:VEVENT');
  const got = ICS.next(text, Date.UTC(2026, 7, 3, 10), 30 * DAY, {});
  check('I14 the next occurrence after a move is the MOVED one, at its new time',
    got.best && got.best.start === Date.UTC(2026, 7, 4, 14, 0, 0) && got.best.event.summary === 'Standup moved',
    got.best && new Date(got.best.start).toISOString() + ' ' + JSON.stringify(got.best.event.summary));
  const hits = ICS.expand(ICS.parse(text)[0], Date.UTC(2026, 7, 3), Date.UTC(2026, 7, 6));
  check('I14b and the parent no longer emits the slot it moved out of',
    !hits.includes(Date.UTC(2026, 7, 4, 9, 0, 0)) && hits.includes(Date.UTC(2026, 7, 5, 9, 0, 0)),
    hits.map((h) => new Date(h).toISOString()).join(','));
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
