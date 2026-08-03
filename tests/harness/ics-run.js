#!/usr/bin/env node
// ICS reader harness — runs widgets/nextevent/ics.js against a table of calendars at a
// FIXED instant and asserts what it picks.
//
//   node tests/harness/ics-run.js                     # the built-in cases
//   node tests/harness/ics-run.js --now 2030-01-01T00:00:00Z
//   node tests/harness/ics-run.js --file my.ics --lookahead 30
//   node tests/harness/ics-run.js --tz America/New_York
//
// WHY A FIXED CLOCK. Every question this reader answers is "which event is next", which
// is meaningless without saying next FROM WHEN. Assertions written against `Date.now()`
// either encode the day they were written — and start failing on their own — or get
// weakened until they assert nothing. So the suite runs at SUITE_NOW and a case can say
// "this weekly repeat resolves to Tuesday the 11th" and keep meaning it forever.
//
// `--now` deliberately does NOT move the suite. A regression suite a command-line flag
// can perturb is one that reports failures nobody caused: the built-in cases pin their
// expectations to SUITE_NOW, so running them at another instant would "fail" every
// case whose event has since gone past. --now governs --file mode, where the question
// is genuinely "what would the widget show at time X", plus any case that names its own.
//
// WHY A FIXED ZONE. parseDate resolves floating and all-day times with the LOCAL
// calendar (`new Date(y, mo-1, d, ...)`), so a case involving either is a different
// instant in a different zone. The runner pins TZ=UTC unless told otherwise, which is
// what stops a green suite here from failing in a contributor's timezone.
//
// The suite is expected GREEN IN EVERY ZONE. It is worth running that way after any
// change to recurrence or to date parsing, because the whole class of bug this file
// exists for looks identical to a passing test until the panel is somewhere else:
//
//   for tz in UTC Asia/Tokyo America/New_York Europe/Berlin Pacific/Auckland; do
//     node tests/harness/ics-run.js --tz "$tz" || echo "FAILED under $tz"
//   done
//
// It once documented a known divergence here — BYDAY evaluated against the LOCAL
// weekday, so a UTC-anchored weekly series landed a day early under Asia/Tokyo. That is
// fixed, and the cases below now pin every anchoring (UTC, TZID, floating) so it cannot
// come back quietly. Cases involving all-day or floating times derive their dates with
// `localStamp`/`localMidnight` rather than hard-coding them, because those two anchor to
// the LOCAL calendar and a hard-coded date silently asserts that the panel's zone agrees
// with UTC — which it does not at ±12, where a hard-coded case failed under
// Pacific/Auckland for a reason that had nothing to do with the reader.
//
// The default stays UTC so CI is deterministic.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

// Before ANY Date is constructed. Node rereads TZ per call, but pinning it up here keeps
// the ordering obvious rather than load-bearing on that detail.
process.env.TZ = opt('tz', 'UTC');

// The instant every built-in case is written against: a Monday, midday UTC.
const SUITE_NOW = '2030-06-10T12:00:00Z';
const FILE_NOW = opt('now', SUITE_NOW);
const nowMs = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    console.error('--now must be a parsable timestamp (e.g. 2030-06-10T12:00:00Z), got: ' + iso);
    process.exit(2);
  }
  return t;
};

// ---- load the reader ------------------------------------------------------------
// ics.js is browser code that attaches to `window`. Give it exactly that and nothing
// else: if it ever reaches for a DOM or a network it should fail here, loudly, rather
// than in a widget frame where the symptom is a blank tile.
const ICS = (() => {
  // --reader points at a DIFFERENT copy of ics.js. That is how a change to the reader
  // gets falsified: run the same cases against the version before it and require the
  // ones it fixes to fail there. A probe that only ever sees the fixed build cannot
  // tell a fix from a case that was always going to pass.
  const readerPath = opt('reader', path.join(__dirname, '../../widgets/nextevent/ics.js'));
  const src = fs.readFileSync(readerPath, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'ics.js' }).runInContext(sandbox);
  if (!sandbox.window.ICS) {
    console.error('ics.js did not attach window.ICS');
    process.exit(2);
  }
  return sandbox.window.ICS;
})();

/** Local midnight of the day an instant falls in — the same computation the widget uses
 *  for `allDayFrom`, because an all-day event is anchored to the local calendar. */
const localMidnight = (iso) => {
  const d = new Date(Date.parse(iso));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Local midnight `days` days from the day `iso` falls in. Calendar arithmetic, so it
 *  stays correct across a DST transition. */
const localMidnightPlus = (iso, days) => {
  const d = new Date(Date.parse(iso));
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + (days || 0));
  return d.getTime();
};

/** `YYYY-MM-DD` of the LOCAL date `days` days from the one `iso` falls in. */
const localDay = (iso, days) => {
  const d = new Date(localMidnightPlus(iso, days));
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

/** The same date as the YYYYMMDD stamp an all-day DTSTART/DTEND takes. Hard-coding a
 *  stamp instead asserts that the panel's zone agrees with UTC about what day it is,
 *  which is false at ±12 and is why a case with nothing to do with zones failed under
 *  Pacific/Auckland. */
const localStamp = (iso, days) => localDay(iso, days).replace(/-/g, '');

/** Local NOON of the day `days` days from the one `iso` falls in. Some cases need an
 *  instant that is strictly INSIDE a local day in every zone, which no fixed UTC instant
 *  is: SUITE_NOW is exactly local midnight at +12, and a case asserting that today's
 *  all-day event has already fallen out of the default window is simply not true at the
 *  moment that day begins. */
const localNoon = (iso, days) => {
  const d = new Date(localMidnightPlus(iso, days));
  d.setHours(12, 0, 0, 0);
  return d.getTime();
};

/** `YYYY-MM-DDTHH:MM` of an instant read on the LOCAL clock. Floating times resolve to
 *  a different UTC instant in every zone but the same WALL time in all of them, so that
 *  is what a floating case has to assert. */
const localWall = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
};

const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

// Instants some cases run at instead of SUITE_NOW, named so the expectations read.
const DAY2 = '2030-06-11T12:00:00Z';        // the day after SUITE_NOW, midday UTC
const DAY3 = '2030-06-12T12:00:00Z';
const BEFORE_SPRING = '2030-03-01T12:00:00Z';   // America/New_York springs forward 2030-03-10
const MID_SPRING = '2030-03-09T12:00:00Z';
const BEFORE_FALL = '2030-11-01T12:00:00Z';     // ...and falls back 2030-11-03
const BEFORE_EU_SPRING = '2030-03-25T12:00:00Z';// Europe/Berlin springs forward 2030-03-31

// ---- cases ----------------------------------------------------------------------
// `now` defaults to SUITE_NOW. `expect.start` is an ISO instant; `expect.best: null` asserts
// the reader finds nothing. `dropped` is asserted whenever the case names it, because a
// silently discarded repeat is the failure this reader most needs to be honest about.
const CASES = [
  {
    name: 'one-off in the future',
    ics: cal(...ev('UID:a', 'DTSTART:20300610T170000Z', 'SUMMARY:Design review', 'LOCATION:Room 2')),
    expect: { summary: 'Design review', start: '2030-06-10T17:00:00Z', location: 'Room 2', dropped: 0 },
  },
  {
    name: 'the SOONEST future event wins, not the first listed',
    ics: cal(
      ...ev('UID:a', 'DTSTART:20300612T090000Z', 'SUMMARY:Later'),
      ...ev('UID:b', 'DTSTART:20300610T140000Z', 'SUMMARY:Sooner')),
    expect: { summary: 'Sooner', start: '2030-06-10T14:00:00Z' },
  },
  {
    name: 'an event already past is not picked',
    ics: cal(...ev('UID:a', 'DTSTART:20300609T090000Z', 'SUMMARY:Yesterday')),
    expect: { best: null },
  },
  {
    name: 'daily repeat resolves to the next occurrence',
    ics: cal(...ev('UID:a', 'DTSTART:20300601T080000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Standup')),
    expect: { summary: 'Standup', start: '2030-06-11T08:00:00Z', dropped: 0 },
  },
  {
    name: 'weekly repeat lands on the right weekday',
    // 2030-06-10 is a Monday; a Tuesday series next fires on the 11th.
    ics: cal(...ev('UID:a', 'DTSTART:20300604T150000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'SUMMARY:Weekly sync')),
    expect: { summary: 'Weekly sync', start: '2030-06-11T15:00:00Z' },
  },
  {
    name: 'a monthly repeat is DROPPED and counted, never silently skipped',
    ics: cal(...ev('UID:a', 'DTSTART:20300601T090000Z', 'RRULE:FREQ=MONTHLY', 'SUMMARY:Monthly ops')),
    expect: { best: null, dropped: 1 },
  },
  {
    name: 'EXDATE removes the occurrence it names',
    ics: cal(...ev('UID:a', 'DTSTART:20300601T080000Z', 'RRULE:FREQ=DAILY',
      'EXDATE:20300611T080000Z', 'SUMMARY:Standup')),
    expect: { summary: 'Standup', start: '2030-06-12T08:00:00Z' },
  },
  {
    name: 'a moved occurrence is shown at its NEW time, not the old one',
    ics: cal(
      ...ev('UID:a', 'DTSTART:20300601T080000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Standup'),
      ...ev('UID:a', 'RECURRENCE-ID:20300611T080000Z', 'DTSTART:20300611T113000Z', 'SUMMARY:Standup (moved)')),
    expect: { summary: 'Standup (moved)', start: '2030-06-11T11:30:00Z' },
  },
  {
    name: 'a cancelled occurrence deletes its slot rather than moving it',
    ics: cal(
      ...ev('UID:a', 'DTSTART:20300601T080000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Standup'),
      ...ev('UID:a', 'RECURRENCE-ID:20300611T080000Z', 'DTSTART:20300611T080000Z',
        'STATUS:CANCELLED', 'SUMMARY:Standup')),
    expect: { summary: 'Standup', start: '2030-06-12T08:00:00Z' },
  },
  {
    name: 'all-day events are included by default',
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:' + localStamp(SUITE_NOW, 1), 'SUMMARY:Company holiday')),
    expect: { summary: 'Company holiday', allDay: true },
  },
  {
    name: 'all-day events are skipped when told to ignore them',
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:' + localStamp(SUITE_NOW, 1), 'SUMMARY:Company holiday')),
    options: { ignoreAllDay: true },
    expect: { best: null },
  },
  {
    name: 'a zoned start is converted, not read as UTC',
    ics: cal(...ev('UID:a', 'DTSTART;TZID=America/New_York:20300610T090000', 'SUMMARY:NY call')),
    expect: { summary: 'NY call', start: '2030-06-10T13:00:00Z' },   // EDT = UTC-4
  },
  {
    name: 'beyond the lookahead window is not picked',
    ics: cal(...ev('UID:a', 'DTSTART:20300720T090000Z', 'SUMMARY:Far future')),
    lookaheadDays: 7,
    expect: { best: null },
  },
  {
    name: 'folded lines are rejoined before parsing',
    ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20300610T170000Z\r\n'
      + 'SUMMARY:A title long enough to be\r\n  folded across two lines\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    expect: { summary: 'A title long enough to be folded across two lines' },
  },
  {
    name: 'escaped text is unescaped, and a newline becomes a space',
    // Deliberately a SPACE, not a newline: both fields render nowrap with ellipsis, so a
    // real line break would either collapse or truncate the rest of the value. Asserting
    // the newline here would have been asserting my own assumption over the reader's
    // intent — the first version of this case did exactly that and called the reader wrong.
    ics: cal(...ev('UID:a', 'DTSTART:20300610T170000Z', 'SUMMARY:Budget\\, Q3', 'LOCATION:Room 2\\nFloor 3')),
    expect: { summary: 'Budget, Q3', location: 'Room 2 Floor 3' },
  },
  {
    name: 'an event with no DTSTART is discarded rather than crashing',
    ics: cal(
      ...ev('UID:a', 'SUMMARY:No start at all'),
      ...ev('UID:b', 'DTSTART:20300610T170000Z', 'SUMMARY:Real one')),
    expect: { summary: 'Real one' },
  },
  {
    name: 'a VALARM inside a VEVENT does not overwrite the event title',
    // An email reminder carries its own SUMMARY. Keeping `cur` active through the nested
    // component meant the tile displayed the alarm's subject as the meeting name.
    ics: cal(...ev('UID:a', 'DTSTART:20300610T170000Z', 'SUMMARY:Design review',
      'BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:Calendar reminder',
      'DESCRIPTION:Do not read this as the location', 'TRIGGER:-PT15M', 'END:VALARM')),
    expect: { summary: 'Design review' },
  },
  {
    name: "today's all-day event is still eligible after 01:00, given allDayFrom",
    // SUITE_NOW is midday, so a window opening an hour earlier (11:00) already excludes
    // an event anchored to local midnight. Without allDayFrom this returns tomorrow's.
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:' + localStamp(SUITE_NOW, 0), 'SUMMARY:Company holiday'),
      ...ev('UID:b', 'DTSTART;VALUE=DATE:' + localStamp(SUITE_NOW, 1), 'SUMMARY:Tomorrow instead')),
    // LOCAL midnight, computed exactly as the widget computes it. Hard-coding the UTC
    // instant instead made this case fail under --tz Asia/Tokyo, because an all-day
    // event is anchored to local midnight and that is a different instant there — the
    // test was wrong about the zone, not the reader. The DATE stamps are derived for the
    // same reason: at +12 the local date is not the UTC date at all.
    nowMs: localNoon(SUITE_NOW, 0),
    options: { allDayFrom: localMidnight(SUITE_NOW) },
    expect: { summary: 'Company holiday', allDay: true, allDayEndMs: localMidnightPlus(SUITE_NOW, 1) },
  },
  {
    name: '...and without allDayFrom it is the pre-fix behaviour, tomorrow',
    // Pinned deliberately: this is what the widget did all day, every day, and the case
    // exists so a future change to the default window is a visible decision. Local noon
    // rather than SUITE_NOW, because the claim is "today's all-day event is already
    // behind the default window" and at +12 SUITE_NOW is the very instant that day
    // begins — where the reader is right to still offer it and the CASE is what is wrong.
    nowMs: localNoon(SUITE_NOW, 0),
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:' + localStamp(SUITE_NOW, 0), 'SUMMARY:Company holiday'),
      ...ev('UID:b', 'DTSTART;VALUE=DATE:' + localStamp(SUITE_NOW, 1), 'SUMMARY:Tomorrow instead')),
    expect: { summary: 'Tomorrow instead' },
  },
  {
    name: 'allDayFrom does not drag TIMED events back into the window',
    // The bound is per-kind. If it leaked to timed events the widget would keep picking
    // a meeting from this morning, discard it as expired, refetch, and pick it again.
    ics: cal(...ev('UID:a', 'DTSTART:20300610T090000Z', 'SUMMARY:This morning'),
      ...ev('UID:b', 'DTSTART:20300610T170000Z', 'SUMMARY:This afternoon')),
    options: { allDayFrom: Date.parse('2030-06-10T00:00:00Z') },
    expect: { summary: 'This afternoon' },
  },
  {
    name: 'lowercase component names parse, because iCalendar is case-insensitive',
    // The widget's BEGIN:VCALENDAR guard is case-insensitive, so a lowercase feed passed
    // validation and then parsed as ZERO events — "Nothing scheduled" about a calendar
    // full of them, with nothing dropped and no error to show for it.
    ics: 'begin:vcalendar\r\nversion:2.0\r\nbegin:vevent\r\nuid:a\r\n'
      + 'dtstart:20300610T170000Z\r\nsummary:Design review\r\nend:vevent\r\nend:vcalendar\r\n',
    expect: { summary: 'Design review', total: 1 },
  },
  {
    name: 'a body that is not a calendar at all yields nothing',
    // The reader's job is to find no events here. The WIDGET's job is to notice that
    // "no events" from a non-calendar is not the same claim as an empty calendar —
    // that check lives in index.html, and this case pins the reader half of it.
    ics: '<!doctype html><html><body>Sign in to view this calendar</body></html>',
    expect: { best: null, total: 0 },
  },

  // ---- recurrence is evaluated in DTSTART's OWN frame, per anchoring ---------------
  // The UTC-anchored weekly case lives above ('weekly repeat lands on the right
  // weekday') and used to fail under Asia/Tokyo. These pin the other two anchorings so
  // a future change cannot fix one frame by breaking another.
  {
    name: 'BYDAY on a TZID series is the weekday in THAT zone, not the panel-local one',
    // 23:00 Tuesday in New York is 03:00 WEDNESDAY in UTC. Reading the weekday off the
    // resolved instant therefore matched the day BEFORE — a Monday in New York — so the
    // series fired a day early for everyone. The next Tuesday after SUITE_NOW is the
    // 11th, 23:00 EDT.
    ics: cal(...ev('UID:a', 'DTSTART;TZID=America/New_York:20300604T230000',
      'RRULE:FREQ=WEEKLY;BYDAY=TU', 'SUMMARY:NY weekly')),
    expect: { summary: 'NY weekly', start: '2030-06-12T03:00:00Z' },
  },
  {
    name: 'BYDAY on a FLOATING series is the local weekday, because that is what floating means',
    // The case a careless "make it all UTC" fix breaks. A floating time is the same wall
    // clock wherever the calendar is read, so the assertion is a wall clock.
    ics: cal(...ev('UID:a', 'DTSTART:20300604T150000', 'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'SUMMARY:Floating weekly')),
    expect: { summary: 'Floating weekly', startLocal: '2030-06-11T15:00' },
  },
  {
    name: 'a TZID series keeps its WALL time across a spring-forward',
    // 09:00 on the 3rd is EST (-5); on the 10th the same wall time is EDT (-4). The
    // occurrence keeps 09:00 and changes instant, which is what a zoned series means.
    now: '2030-03-04T12:00:00Z',
    ics: cal(...ev('UID:a', 'DTSTART;TZID=America/New_York:20300303T090000',
      'RRULE:FREQ=WEEKLY;BYDAY=SU', 'SUMMARY:Sunday sync')),
    expect: { summary: 'Sunday sync', start: '2030-03-10T13:00:00Z' },
  },
  {
    name: 'a UTC-anchored series keeps its OFFSET across the same transition',
    // The mirror of the case above: `...Z` names an instant, so a DST transition in
    // whatever zone the panel sits in must not move it.
    now: '2030-03-04T12:00:00Z',
    ics: cal(...ev('UID:a', 'DTSTART:20300303T140000Z', 'RRULE:FREQ=WEEKLY;BYDAY=SU',
      'SUMMARY:UTC sunday')),
    expect: { summary: 'UTC sunday', start: '2030-03-10T14:00:00Z' },
  },
  {
    name: 'a FLOATING series keeps its wall time across the same transition',
    now: '2030-03-04T12:00:00Z',
    ics: cal(...ev('UID:a', 'DTSTART:20300303T090000', 'RRULE:FREQ=WEEKLY;BYDAY=SU',
      'SUMMARY:Floating sunday')),
    expect: { summary: 'Floating sunday', startLocal: '2030-03-10T09:00' },
  },

  // ---- INTERVAL counts weeks from the WKST boundary, not from DTSTART --------------
  {
    name: 'a fortnightly rule counts weeks from the WKST boundary, not from DTSTART',
    // DTSTART is WEDNESDAY the 5th. Its week (Mon 3rd – Sun 9th) is week 0, so the
    // following Monday the 10th is in week 1 and is NOT active — the next active Monday
    // is the 17th. Counting seven-day blocks from DTSTART put the 10th in block 0 and
    // emitted it, so a fortnightly review appeared a week early.
    now: '2030-06-05T12:00:00Z',
    ics: cal(...ev('UID:a', 'DTSTART:20300605T090000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
      'SUMMARY:Fortnightly review')),
    expect: { summary: 'Fortnightly review', start: '2030-06-17T09:00:00Z', dropped: 0 },
  },
  {
    name: '...and INTERVAL=1 still fires every week, so the fix is not "always skip one"',
    now: '2030-06-05T12:00:00Z',
    ics: cal(...ev('UID:a', 'DTSTART:20300605T090000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
      'SUMMARY:Weekly review')),
    expect: { summary: 'Weekly review', start: '2030-06-10T09:00:00Z' },
  },
  {
    name: 'WKST moves the boundary, and the same calendar answers differently because of it',
    // DTSTART is SUNDAY the 9th. Under the default WKST=MO it sits at the END of week 0,
    // so the Monday of the 10th opens week 1 — inactive. Under WKST=SU it OPENS week 0,
    // so that same Monday is still week 0 — active. Two different right answers, which is
    // why the boundary cannot be assumed.
    now: '2030-06-09T12:00:00Z',
    ics: cal(...ev('UID:a', 'DTSTART:20300609T090000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
      'SUMMARY:Default WKST')),
    expect: { summary: 'Default WKST', start: '2030-06-17T09:00:00Z' },
  },
  {
    name: '...the same rule with WKST=SU fires a week earlier, and is no longer refused',
    now: '2030-06-09T12:00:00Z',
    ics: cal(...ev('UID:a', 'DTSTART:20300609T090000Z',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU', 'SUMMARY:Sunday WKST')),
    expect: { summary: 'Sunday WKST', start: '2030-06-10T09:00:00Z', dropped: 0 },
  },
  {
    name: 'a WKST this reader cannot read is refused rather than assumed to be Monday',
    ics: cal(...ev('UID:a', 'DTSTART:20300605T090000Z',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=XX', 'SUMMARY:Nonsense WKST')),
    expect: { best: null, dropped: 1 },
  },

  // ---- an unresolvable TZID is refused and counted, never re-read locally ----------
  {
    name: 'a TZID Intl cannot resolve is DROPPED and counted, not silently read as local time',
    // Exchange and Notes exports define their own identifiers via VTIMEZONE. Re-reading
    // the wall time in the panel's zone produced an event hours off with nothing marking
    // it — and crucially not counted, so the tile's one honesty mechanism stayed quiet.
    ics: cal(...ev('UID:a', 'DTSTART;TZID=Customized Time Zone:20300610T170000',
      'SUMMARY:Unknown zone')),
    expect: { best: null, dropped: 1 },
  },
  {
    name: '...while a FLOATING time still resolves locally, which is correct and different',
    // The thing a careless fix to the case above breaks: floating is not "unknown zone",
    // it is "whatever the local wall clock says", and it must keep meaning that. The date
    // is derived because a hard-coded 17:00 on SUITE_NOW's UTC date is already in the
    // PAST at +9, where midday UTC is evening — the event would be missing for a reason
    // that has nothing to do with what the case is testing.
    ics: cal(...ev('UID:a', 'DTSTART:' + localStamp(SUITE_NOW, 1) + 'T170000',
      'SUMMARY:Floating one-off')),
    expect: { summary: 'Floating one-off', startLocal: localDay(SUITE_NOW, 1) + 'T17:00', dropped: 0 },
  },

  // ---- RANGE=THISANDFUTURE ---------------------------------------------------------
  {
    name: 'a THISANDFUTURE reschedule shows the new time and REFUSES the obsolete parent',
    ics: cal(
      ...ev('UID:a', 'DTSTART:20300601T080000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Standup'),
      ...ev('UID:a', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20300611T080000Z',
        'DTSTART:20300611T103000Z', 'SUMMARY:Standup (rescheduled)')),
    expect: { summary: 'Standup (rescheduled)', start: '2030-06-11T10:30:00Z', dropped: 1 },
  },
  {
    name: '...so no LATER occurrence is offered at the time the series moved away from',
    // The failure the refusal exists for: read as a single move, the parent went on
    // emitting 08:00 every day after the reschedule, presenting the old schedule as
    // current indefinitely. Refusing costs the rest of the series and says so.
    now: DAY2,
    ics: cal(
      ...ev('UID:a', 'DTSTART:20300601T080000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Standup'),
      ...ev('UID:a', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20300611T080000Z',
        'DTSTART:20300611T103000Z', 'SUMMARY:Standup (rescheduled)')),
    expect: { best: null, dropped: 1 },
  },

  // ---- multi-day all-day events ----------------------------------------------------
  {
    name: 'a multi-day all-day event is still on during its SECOND day',
    // DTEND is exclusive, so start+2 covers two days. Eligibility tested only the start,
    // so at midnight on day two the event dropped off the tile while it was still running
    // — vacations and conferences silently became one-day entries.
    now: DAY2,
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:' + localStamp(DAY2, -1),
      'DTEND;VALUE=DATE:' + localStamp(DAY2, 1), 'SUMMARY:Conference')),
    options: { allDayFrom: localMidnight(DAY2) },
    expect: { summary: 'Conference', allDay: true, allDayEndMs: localMidnightPlus(DAY2, 1) },
  },
  {
    name: '...and is NOT on the day after DTEND, because DTEND is exclusive',
    // The off-by-one is the whole risk here: reading DTEND as inclusive keeps the event
    // one day past its own calendar.
    now: DAY3,
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:' + localStamp(DAY3, -2),
      'DTEND;VALUE=DATE:' + localStamp(DAY3, 0), 'SUMMARY:Conference')),
    options: { allDayFrom: localMidnight(DAY3) },
    expect: { best: null },
  },
  {
    name: '...and a single-day all-day event with no DTEND is unaffected',
    now: DAY2,
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:' + localStamp(DAY2, -1), 'SUMMARY:Yesterday only'),
      ...ev('UID:b', 'DTSTART;VALUE=DATE:' + localStamp(DAY2, 0), 'SUMMARY:Today')),
    options: { allDayFrom: localMidnight(DAY2) },
    expect: { summary: 'Today', allDay: true, allDayEndMs: localMidnightPlus(DAY2, 1) },
  },

  // ---- a cancellation that carries no DTSTART of its own ---------------------------
  {
    name: 'a startless CANCELLED override still cancels its occurrence',
    // An iCalendar object with a METHOD may identify the removed occurrence with
    // UID + RECURRENCE-ID + STATUS:CANCELLED and nothing else. Discarded at parse time
    // for having no DTSTART, it never reached reconciliation and the parent kept
    // advertising a meeting that had been called off.
    ics: cal(
      ...ev('UID:a', 'DTSTART:20300601T080000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Standup'),
      ...ev('UID:a', 'RECURRENCE-ID:20300611T080000Z', 'STATUS:CANCELLED')),
    expect: { summary: 'Standup', start: '2030-06-12T08:00:00Z', dropped: 0 },
  },

  // ---- escaping --------------------------------------------------------------------
  {
    name: 'an escaped backslash before an n stays a backslash',
    // `\\` is the escape for a literal backslash. Replacing `\n` first matched the SECOND
    // backslash plus the n and produced `Path \ etwork`; UNC and Windows paths in a
    // LOCATION are the everyday case.
    ics: cal(...ev('UID:a', 'DTSTART:20300610T170000Z', 'SUMMARY:Deploy',
      'LOCATION:Path \\\\network')),
    expect: { summary: 'Deploy', location: 'Path \\network' },
  },
  {
    name: 'an escape this reader does not define keeps both characters',
    ics: cal(...ev('UID:a', 'DTSTART:20300610T170000Z', 'SUMMARY:Tab \\t here')),
    expect: { summary: 'Tab \\t here' },
  },

  // ---- wall times that happen twice, or not at all ---------------------------------
  {
    name: 'a wall time inside the spring-forward GAP takes the offset before it',
    // 02:30 does not exist on 2030-03-10 in New York. The old fixed-point iteration
    // oscillated between the offsets either side and returned whichever pass two landed
    // on — 06:30Z, the wrong side, advertising the event two hours early.
    now: BEFORE_SPRING,
    ics: cal(...ev('UID:a', 'DTSTART;TZID=America/New_York:20300310T023000', 'SUMMARY:Gap time')),
    expect: { summary: 'Gap time', start: '2030-03-10T07:30:00Z' },
  },
  {
    name: '...an hour before the gap is untouched',
    now: BEFORE_SPRING,
    ics: cal(...ev('UID:a', 'DTSTART;TZID=America/New_York:20300310T013000', 'SUMMARY:Before')),
    expect: { summary: 'Before', start: '2030-03-10T06:30:00Z' },
  },
  {
    name: '...and an hour after it is untouched',
    now: BEFORE_SPRING,
    ics: cal(...ev('UID:a', 'DTSTART;TZID=America/New_York:20300310T033000', 'SUMMARY:After')),
    expect: { summary: 'After', start: '2030-03-10T07:30:00Z' },
  },
  {
    name: 'a wall time that happens TWICE takes the earlier of the two',
    // 01:30 occurs at both -04:00 and -05:00 on 2030-11-03. RFC 5545 §3.3.5 takes the
    // offset in effect before the transition, which is the earlier instant.
    // A GUARD, not a fix: the old iteration happened to land here too. It is pinned
    // because the gap rule and this one are opposite halves of the same paragraph, and a
    // rewrite that gets the gap right by taking "the other side" everywhere breaks this.
    now: BEFORE_FALL,
    ics: cal(...ev('UID:a', 'DTSTART;TZID=America/New_York:20301103T013000', 'SUMMARY:Twice')),
    expect: { summary: 'Twice', start: '2030-11-03T05:30:00Z' },
  },
  {
    name: 'the gap rule holds where the offset is POSITIVE, not just west of UTC',
    // Europe/Berlin springs forward 2030-03-31: 02:30 CET does not exist, and the offset
    // before it is +01:00. Picking "the smaller offset" has to mean the same thing on
    // both sides of the prime meridian.
    // The old iteration ALSO answered this one correctly — which is the point. It got
    // Berlin right and New York wrong from the same code, because it was landing on
    // whichever side pass two reached rather than deciding. Pinned so the rule is held
    // to both signs rather than tuned until the one failing case goes green.
    now: BEFORE_EU_SPRING,
    ics: cal(...ev('UID:a', 'DTSTART;TZID=Europe/Berlin:20300331T023000', 'SUMMARY:Berlin gap')),
    expect: { summary: 'Berlin gap', start: '2030-03-31T01:30:00Z' },
  },
  {
    name: 'a RECURRING series still SKIPS the nonexistent occurrence rather than shifting it',
    // Existing behaviour, pinned: the round-trip guard in instantAt drops the occurrence
    // on the gap morning, and resolving one-off gap times correctly must not change that.
    now: MID_SPRING,
    ics: cal(...ev('UID:a', 'DTSTART;TZID=America/New_York:20300308T023000',
      'RRULE:FREQ=DAILY', 'SUMMARY:Early standup')),
    expect: { summary: 'Early standup', start: '2030-03-11T06:30:00Z' },
  },
];

// ---- run ------------------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
let failures = 0;
let ran = 0;

function check(c) {
  ran++;
  // `nowMs` is for cases that must run at an instant derived from the LOCAL clock, which
  // no fixed ISO string can be in every zone.
  const from = c.nowMs !== undefined ? c.nowMs : nowMs(c.now || SUITE_NOW);
  const lookaheadDays = c.lookaheadDays === undefined ? 30 : c.lookaheadDays;
  let got;
  try {
    got = ICS.next(c.ics, from, lookaheadDays * 86400000, c.options || {});
  } catch (e) {
    console.log('  FAIL ' + c.name + '\n        threw: ' + (e && e.message));
    failures++;
    return;
  }
  const problems = [];
  const e = c.expect || {};
  if ('best' in e && e.best === null) {
    if (got.best) problems.push('expected no event, got "' + (got.best.event.summary || '') + '" at ' + iso(got.best.start));
  } else {
    if (!got.best) problems.push('expected an event, got none');
  }
  if (got.best) {
    if (e.summary !== undefined && got.best.event.summary !== e.summary)
      problems.push('summary: expected ' + JSON.stringify(e.summary) + ', got ' + JSON.stringify(got.best.event.summary));
    if (e.location !== undefined && (got.best.event.location || '') !== e.location)
      problems.push('location: expected ' + JSON.stringify(e.location) + ', got ' + JSON.stringify(got.best.event.location || ''));
    if (e.start !== undefined && got.best.start !== nowMs(e.start))
      problems.push('start: expected ' + e.start + ', got ' + iso(got.best.start));
    // A floating occurrence is a different UTC instant in every zone and the SAME wall
    // clock in all of them, so that is the only assertion that can be right everywhere.
    if (e.startLocal !== undefined && localWall(got.best.start) !== e.startLocal)
      problems.push('local start: expected ' + e.startLocal + ', got ' + localWall(got.best.start));
    if (e.allDay !== undefined && !!got.best.event.start.allDay !== e.allDay)
      problems.push('allDay: expected ' + e.allDay + ', got ' + !!got.best.event.start.allDay);
    // When a multi-day all-day occurrence stops being current. The widget's expiry reads
    // this, so a wrong value is a tile that discards an event the next query picks again.
    if (e.allDayEndMs !== undefined && got.best.allDayEnd !== e.allDayEndMs)
      problems.push('allDayEnd: expected ' + iso(e.allDayEndMs) + ', got '
        + (got.best.allDayEnd == null ? 'null' : iso(got.best.allDayEnd)));
  }
  if (e.dropped !== undefined && got.dropped !== e.dropped)
    problems.push('dropped: expected ' + e.dropped + ', got ' + got.dropped);
  if (e.total !== undefined && got.total !== e.total)
    problems.push('total: expected ' + e.total + ', got ' + got.total);

  if (problems.length) {
    console.log('  FAIL ' + c.name);
    for (const p of problems) console.log('        ' + p);
    failures++;
  } else {
    console.log('  ok   ' + c.name);
  }
}

const file = opt('file', null);
if (file) {
  // Ad-hoc mode: read one real calendar and report what the widget would show. No
  // assertions — this is for looking at an export that behaves oddly in the field.
  const from = nowMs(FILE_NOW);
  const lookaheadDays = Number(opt('lookahead', 30));
  // The SAME bounds load() uses, or this mode answers a different question from the one
  // it claims to. Timed events are eligible from an hour ago, all-day ones from local
  // midnight; querying from the bare instant reported tomorrow's all-day event, or none,
  // for an export whose tile would have shown today's — which is exactly the confusion
  // someone reaches for this mode to resolve.
  const got = ICS.next(fs.readFileSync(file, 'utf8'), from - 3600000,
    lookaheadDays * 86400000 + 3600000,
    { ignoreAllDay: args.includes('--ignore-all-day'), allDayFrom: localMidnight(FILE_NOW) });
  console.log('at ' + iso(from) + ' (TZ=' + process.env.TZ + '), looking ahead ' + lookaheadDays + ' days:');
  console.log('  events parsed: ' + got.total + ' | repeats dropped: ' + got.dropped);
  console.log(got.best
    ? '  next: ' + JSON.stringify(got.best.event.summary || '(no title)') + ' at ' + iso(got.best.start)
      + (got.best.event.start.allDay ? ' (all day)' : '')
    : '  next: nothing in range');
  process.exit(0);
}

/** A busy TZID calendar, read once, timed.
 *
 *  Every zone conversion used to construct its own Intl.DateTimeFormat, and a single
 *  candidate occurrence costs three of them, so this grew with the number of occurrences
 *  rather than with the number of events: 400 unbounded daily America/New_York events
 *  over a 90-day lookahead took ~11.9 s here, on what in the widget is the main thread —
 *  the 1 Hz countdown frozen for the duration, and paid again on every poll. With one
 *  formatter memoised per zone the same read is ~1.0 s.
 *
 *  The threshold is deliberately loose. It is not a benchmark; it is a tripwire for a
 *  return to per-call construction, which costs an order of magnitude and would blow any
 *  figure in this range even on a slow runner. The RESULT is asserted alongside it,
 *  because a cache that handed back the wrong zone's offsets would also look like a
 *  speedup. */
function checkPerf() {
  ran++;
  const N = 400;
  const MAX_MS = 5000;
  const lines = [];
  for (let i = 0; i < N; i++) {
    lines.push(...ev('UID:e' + i, 'DTSTART;TZID=America/New_York:20300601T0' + (i % 9) + '0000',
      'RRULE:FREQ=DAILY', 'SUMMARY:Ev' + i));
  }
  const from = nowMs(SUITE_NOW);
  const t0 = Date.now();
  const got = ICS.next(cal(...lines), from, 90 * 86400000, {});
  const took = Date.now() - t0;
  const problems = [];
  if (took > MAX_MS) problems.push('took ' + took + ' ms, over the ' + MAX_MS + ' ms ceiling');
  if (got.total !== N) problems.push('total: expected ' + N + ', got ' + got.total);
  if (got.dropped !== 0) problems.push('dropped: expected 0, got ' + got.dropped);
  if (!got.best) problems.push('expected an event, got none');
  else if (got.best.start < from) problems.push('picked an occurrence before `from`: ' + iso(got.best.start));
  const name = 'a busy TZID calendar is read without rebuilding a formatter per occurrence';
  if (problems.length) {
    console.log('  FAIL ' + name);
    for (const p of problems) console.log('        ' + p);
    failures++;
  } else {
    console.log('  ok   ' + name + ' (' + N + ' events, ' + took + ' ms)');
  }
}

console.log('ics reader — ' + (CASES.length + 1) + ' cases at ' + iso(nowMs(SUITE_NOW)) + ', TZ=' + process.env.TZ);
for (const c of CASES) check(c);
checkPerf();
if (failures) {
  console.log('\n' + failures + ' of ' + ran + ' cases failed');
  process.exit(1);
}
console.log('\nics reader agrees with all ' + ran + ' cases');
