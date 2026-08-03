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
// KNOWN DIVERGENCE, and `--tz` is how to see it:
//
//   node tests/harness/ics-run.js --tz Asia/Tokyo
//   FAIL weekly repeat lands on the right weekday
//         start: expected 2030-06-11T15:00:00Z, got 2030-06-10T15:00:00Z
//
// expand() evaluates BYDAY against the LOCAL weekday even when DTSTART is UTC-anchored.
// RFC 5545 evaluates it in DTSTART's own zone, which for a `...Z` time is UTC, so a
// UTC-anchored weekly series resolves to the wrong day for anyone far enough from UTC.
// Fixing that is a change to recurrence semantics and wants its own falsification pass,
// so it is filed rather than folded into this one. The suite stays at UTC so CI reports
// regressions rather than this.
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

const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

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
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:20300611', 'SUMMARY:Company holiday')),
    expect: { summary: 'Company holiday', allDay: true },
  },
  {
    name: 'all-day events are skipped when told to ignore them',
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:20300611', 'SUMMARY:Company holiday')),
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
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:20300610', 'SUMMARY:Company holiday'),
      ...ev('UID:b', 'DTSTART;VALUE=DATE:20300611', 'SUMMARY:Tomorrow instead')),
    // LOCAL midnight, computed exactly as the widget computes it. Hard-coding the UTC
    // instant instead made this case fail under --tz Asia/Tokyo, because an all-day
    // event is anchored to local midnight and that is a different instant there — the
    // test was wrong about the zone, not the reader.
    options: { allDayFrom: localMidnight(SUITE_NOW) },
    expect: { summary: 'Company holiday', allDay: true },
  },
  {
    name: '...and without allDayFrom it is the pre-fix behaviour, tomorrow',
    // Pinned deliberately: this is what the widget did all day, every day, and the case
    // exists so a future change to the default window is a visible decision.
    ics: cal(...ev('UID:a', 'DTSTART;VALUE=DATE:20300610', 'SUMMARY:Company holiday'),
      ...ev('UID:b', 'DTSTART;VALUE=DATE:20300611', 'SUMMARY:Tomorrow instead')),
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
];

// ---- run ------------------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
let failures = 0;
let ran = 0;

function check(c) {
  ran++;
  const from = nowMs(c.now || SUITE_NOW);
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
    if (e.allDay !== undefined && !!got.best.event.start.allDay !== e.allDay)
      problems.push('allDay: expected ' + e.allDay + ', got ' + !!got.best.event.start.allDay);
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

console.log('ics reader — ' + CASES.length + ' cases at ' + iso(nowMs(SUITE_NOW)) + ', TZ=' + process.env.TZ);
for (const c of CASES) check(c);
if (failures) {
  console.log('\n' + failures + ' of ' + ran + ' cases failed');
  process.exit(1);
}
console.log('\nics reader agrees with all ' + ran + ' cases');
