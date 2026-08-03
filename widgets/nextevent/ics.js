/* Minimal ICS reader, bundled because the sandbox has no CDN and no shared runtime.
 *
 * Scope is deliberate and documented in the widget's README section: it reads VEVENTs
 * and expands DAILY and WEEKLY recurrences. Anything it cannot expand EXACTLY it drops
 * and counts, because on a glanceable panel a wrong time is worse than no time — a
 * monthly standup rendered a week late is a meeting missed with confidence.
 *
 * Supported:
 *   DTSTART / DTEND, with VALUE=DATE (all-day, including multi-day via the exclusive
 *     DTEND), a TZID, a trailing Z, or floating
 *   SUMMARY, LOCATION, UID
 *   RRULE: FREQ=DAILY|WEEKLY, INTERVAL, COUNT, UNTIL, BYDAY (weekly), WKST
 *   EXDATE (excluded occurrences)
 *   RECURRENCE-ID overrides, reconciled against their parent series
 * Dropped (counted, never guessed):
 *   FREQ=MONTHLY|YEARLY|HOURLY|MINUTELY|SECONDLY, BYSETPOS, BYMONTHDAY, RDATE,
 *   a TZID this browser's Intl cannot resolve, and the parent of a
 *   RECURRENCE-ID;RANGE=THISANDFUTURE reschedule
 *
 * Recurrence is evaluated in DTSTART's OWN frame — UTC for a `Z` start, the named zone
 * for a TZID, the local calendar for a floating or all-day one — as RFC 5545 §3.3.10
 * requires. Reading a weekday or a week boundary off the panel's calendar instead is how
 * a weekly series lands a day out for anyone far enough from UTC.
 */
(function (global) {
  'use strict';

  const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  // RFC 5545 line folding: a continuation starts with a space or tab and belongs to
  // the previous line. Unfold before anything else or a long SUMMARY parses as junk.
  function unfold(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  }

  // ONE formatter per zone, for the lifetime of the page. Every zone conversion below
  // used to construct its own, and a single candidate occurrence costs three of them
  // (two offset probes plus the round-trip read) — so a 90-day lookahead over a busy
  // TZID calendar built thousands. Measured in the reader harness on unbounded daily
  // America/New_York events: ~2.5 s for 100, ~12.6 s for 500, all of it on the widget's
  // main thread, freezing the 1 Hz countdown for the duration and paid again every poll.
  //
  // A zone Intl cannot resolve THROWS out of the constructor, so nothing is stored for
  // it — the cache cannot memoise a failure and turn one bad zone into a permanently
  // poisoned entry. Callers see the same throw they saw before.
  const dtfCache = new Map();
  function formatterFor(tz) {
    let dtf = dtfCache.get(tz);
    if (!dtf) {
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      dtfCache.set(tz, dtf);
    }
    return dtf;
  }

  function partsInZone(utcMs, tz) {
    const m = {};
    for (const p of formatterFor(tz).formatToParts(new Date(utcMs))) m[p.type] = p.value;
    return { y: +m.year, mo: +m.month, d: +m.day, h: (+m.hour) % 24, mi: +m.minute, s: +m.second };
  }

  // What time is `wall clock in this zone` in UTC? Intl knows every IANA zone the
  // browser ships, which is how a TZID is honored without bundling a tz database.
  function tzOffsetMs(utcMs, tz) {
    const p = partsInZone(utcMs, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - utcMs;
  }

  /** The instant a wall clock in `tz` names — including the two dates that are not a
   *  simple question.
   *
   *  This used to iterate `guess = naive - tzOffsetMs(guess, tz)` twice and return
   *  whatever the second pass produced. That converges when one offset covers the date,
   *  and OSCILLATES when the wall time sits at a transition, so the answer for a
   *  spring-forward morning was whichever side iteration two happened to land on:
   *  `TZID=America/New_York:20300310T023000` came back as 06:30Z (01:30 local, the wrong
   *  side of a gap the clock skips) and the tile advertised the event two hours early.
   *
   *  RFC 5545 §3.3.5 states both rules and they are opposites, which is why guessing
   *  cannot get both: a wall time that occurs TWICE (fall back) takes the offset in
   *  effect BEFORE the transition — the earlier of the two instants — and one that
   *  occurs NOT AT ALL (spring forward) also takes the offset before the transition,
   *  which for a gap yields the LATER instant. Both are computed here rather than
   *  approached. */
  function zonedToUtc(y, mo, d, h, mi, s, tz) {
    const naive = Date.UTC(y, mo - 1, d, h, mi, s);
    const o1 = tzOffsetMs(naive, tz);
    const t1 = naive - o1;
    const o2 = tzOffsetMs(t1, tz);
    // One offset governs this date: no transition is in reach and t1 is the answer.
    if (o1 === o2) return t1;
    // naive and t1 straddle a transition, so o1 and o2 ARE the offsets either side of it.
    const t2 = naive - o2;
    const reads = (t) => {
      const p = partsInZone(t, tz);
      return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
    };
    const r1 = reads(t1), r2 = reads(t2);
    // Both read back: the wall time happens twice. The earlier instant is the one under
    // the pre-transition offset.
    if (r1 && r2) return Math.min(t1, t2);
    if (r1) return t1;
    if (r2) return t2;
    // Neither: the clock skips this wall time. A gap means the offset INCREASES, so the
    // offset in effect before it is the smaller of the two.
    return naive - Math.min(o1, o2);
  }

  /** The wall-clock fields DTSTART actually names, in the event's own frame. */
  function wallOf(start) {
    if (start.tz) return partsInZone(start.ms, start.tz);
    const d = new Date(start.ms);
    if (start.floating || start.allDay) {
      return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
    }
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }

  /** The instant `dayOffset` days after DTSTART, at DTSTART's WALL-CLOCK time.
   *
   * Iterating on the resolved instant was wrong twice over. Stepping it by 86,400,000 ms
   * drifts an hour across a DST transition; stepping it through the zone and then using
   * the RESULT as the next baseline lets one bad conversion poison every step after it.
   * A 02:30 America/New_York daily series hit both: 02:30 does not exist on the spring
   * -forward morning, so it resolved to 01:30 and then stayed 01:30 for good.
   *
   * Recurrence is defined on the CALENDAR, so the calendar is what advances: the day is
   * offset from DTSTART's own date and the time comes from DTSTART every single step.
   * Returns null for an instant that does not exist (the gap), which the caller skips
   * rather than rendering at a shifted time. */
  /** The calendar date `dayOffset` days after DTSTART's own date, and its weekday.
   *
   *  Everything a recurrence rule reasons about lives on THIS calendar. BYDAY used to be
   *  matched with `new Date(ms).getDay()` — the weekday of the resolved instant read in
   *  the PANEL's zone — so "every Tuesday, 15:00Z" produced Tuesdays wherever the tile
   *  happened to be running. Far enough from UTC that 15:00Z falls on a different local
   *  day, the whole series shifts: under Asia/Tokyo the reader answered Monday 15:00Z for
   *  a Tuesday rule, a full day before the meeting, with a countdown that expired early
   *  and nothing on the tile to suggest the day was derived rather than read.
   *  RFC 5545 §3.3.10 evaluates rules in DTSTART's own zone, and this date IS that zone's
   *  calendar — it is built from DTSTART's wall-clock fields, whichever of the three
   *  anchorings produced them. */
  function calendarAt(anchor, dayOffset) {
    const shifted = new Date(Date.UTC(anchor.y, anchor.mo - 1, anchor.d + dayOffset));
    return {
      y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1,
      d: shifted.getUTCDate(), dow: shifted.getUTCDay(),
    };
  }

  function instantAt(anchor, cal, frame) {
    const y = cal.y, mo = cal.mo, d = cal.d;
    if (frame.tz) {
      const ms = zonedToUtc(y, mo, d, anchor.h, anchor.mi, anchor.s, frame.tz);
      // Round-trip: if the instant does not read back as the local time we asked for,
      // that local time does not exist on that date and the occurrence is skipped.
      const back = partsInZone(ms, frame.tz);
      if (back.h !== anchor.h || back.mi !== anchor.mi) return null;
      return ms;
    }
    if (frame.floating || frame.allDay) {
      const dt = new Date(y, mo - 1, d, anchor.h, anchor.mi, anchor.s);
      if (dt.getHours() !== anchor.h || dt.getMinutes() !== anchor.mi) return null;
      return dt.getTime();
    }
    return Date.UTC(y, mo - 1, d, anchor.h, anchor.mi, anchor.s);
  }

  // Returns {ms, allDay, floating} or null. A floating time (no Z, no TZID) is local
  // by specification — the same wall clock wherever the calendar is read.
  function parseDate(value, params) {
    const raw = String(value || '').trim();
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
    if (!m) return null;
    const [, Y, Mo, D, H, Mi, S, Z] = m;
    const y = +Y, mo = +Mo, d = +D;
    if (H === undefined || (params && params.VALUE === 'DATE')) {
      // All-day: local midnight, so "today" means today for the person looking at it.
      return { ms: new Date(y, mo - 1, d, 0, 0, 0).getTime(), allDay: true, floating: false, tz: null };
    }
    const h = +H, mi = +Mi, s = +S;
    if (Z) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false, floating: false, tz: null };
    const tz = params && params.TZID;
    if (tz) {
      // The zone is carried, not just applied: recurrence stepping needs the frame to
      // keep the wall clock stable across a DST transition.
      try { return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), allDay: false, floating: false, tz }; }
      catch (e) {
        // A zone Intl cannot resolve. This used to fall through to the branch below and
        // re-read the wall time in the PANEL's zone, which is a different instant with
        // nothing to mark it — an event hours off, not counted in `dropped`, so the
        // tile's one honesty mechanism stayed silent about it. Calendars define their
        // own identifiers via VTIMEZONE all the time (`(GMT+01.00) Amsterdam`,
        // Exchange-style names, `Customized Time Zone`) and Intl knows none of them.
        //
        // Until VTIMEZONE is actually parsed, the honest answer is that this time cannot
        // be read. A null `ms` makes the event unexpandable, which is already the path
        // that counts it and says so. NOT floating: floating means "whatever the local
        // wall clock says", which is a real and different thing this must not be
        // confused with — a floating time still resolves locally, correctly, below.
        return { ms: null, allDay: false, floating: false, tz, unresolvedTz: true };
      }
    }
    return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false, floating: true, tz: null };
  }

  function parseParams(chunk) {
    const params = {};
    for (const part of chunk.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
    }
    return params;
  }

  /** RFC 5545 §3.3.11 escapes, decoded in ONE left-to-right pass.
   *
   *  As four sequential replaces this was order-dependent in a way that could not be
   *  fixed by reordering: `\\` is the escape for a literal backslash, so in
   *  `Path \\network` the newline rule matched the SECOND backslash plus the `n` and
   *  produced `Path \ etwork`. Putting the backslash rule first breaks the mirror case
   *  instead. A single pass is the fix, because a backslash it has already consumed can
   *  never be read again as the start of another escape.
   *
   *  `\n` becomes a SPACE rather than a newline on purpose: the title and location lines
   *  are single-line with ellipsis, so a real newline would hide everything after it.
   *  An escape this reader does not define keeps both characters — dropping the
   *  backslash would silently rewrite text nobody asked it to interpret. */
  function unescapeText(s) {
    const str = String(s || '');
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c !== '\\') { out += c; continue; }
      const n = str[i + 1];
      if (n === undefined) { out += c; break; }   // a trailing lone backslash is literal
      i++;
      if (n === 'n' || n === 'N') out += ' ';
      else if (n === ',' || n === ';' || n === '\\') out += n;
      else out += c + n;
    }
    return out.trim();
  }

  function parseRRule(value) {
    const out = {};
    for (const part of String(value || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
    }
    return out;
  }

  // Every RRULE part this reader actually implements. Anything else — BYMONTHDAY,
  // BYSETPOS, BYMONTH, BYWEEKNO, BYHOUR, WKST — either CONSTRAINS the series or moves
  // its week boundary, so ignoring one produces occurrences the rule does not describe.
  // `FREQ=DAILY;BYMONTHDAY=15` means the 15th of each month; ignoring BYMONTHDAY
  // renders it as every single day. Unknown parts are refused, not skipped.
  // WKST is now implemented rather than refused, because the week boundary it names is
  // what INTERVAL counts from — see the week index in expand().
  const KNOWN_RRULE = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST']);

  /** Occurrences of one event at or after `from`, up to `until`, newest-last.
   *  Returns null for a rule this reader cannot expand EXACTLY. */
  function expand(event, from, until) {
    // A start this reader could not resolve — today that is only an unresolvable TZID.
    // Refusing here is what routes it to the caller's `dropped` counter, which is the
    // tile's one way of saying an event exists that it will not show.
    if (!event.start || event.start.ms == null) return null;
    // RANGE=THISANDFUTURE reschedules the series from an occurrence forward, so every
    // later occurrence of the PARENT is obsolete. See the reconciliation in parse().
    if (event.unsupportedRange) return null;
    const start = event.start.ms;
    const frame = event.start;
    // RDATE names extra occurrences outright. Nothing here expands them, and treating
    // the event as a plain one-off hid a scheduled date completely — a past DTSTART
    // with a future RDATE read as "finished" with nothing dropped.
    if (event.hasRdate) return null;
    if (!event.rrule) return (start >= from && start <= until) ? [start] : [];

    const rule = event.rrule;
    const freq = String(rule.FREQ || '').toUpperCase();
    if (freq !== 'DAILY' && freq !== 'WEEKLY') return null;   // null = "cannot expand"
    for (const key of Object.keys(rule)) if (!KNOWN_RRULE.has(key)) return null;
    // BYDAY on a DAILY rule is a filter we do not apply; refuse rather than over-emit.
    if (freq === 'DAILY' && rule.BYDAY) return null;

    const interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1);
    const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;
    const untilRule = rule.UNTIL ? parseDate(rule.UNTIL, {}) : null;
    const hardUntil = Math.min(until, untilRule && untilRule.ms != null ? untilRule.ms : until);

    const byDay = freq === 'WEEKLY' && rule.BYDAY
      ? String(rule.BYDAY).split(',').map((d) => DAYS[d.trim().slice(-2).toUpperCase()]).filter((n) => n !== undefined)
      : null;

    // The week INTERVAL counts from the week boundary WKST names — Monday unless the
    // rule says otherwise (RFC 5545 §3.3.10) — not from DTSTART. Counting from DTSTART
    // cut time into seven-day blocks starting on whatever day the series began, so
    // `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO` with a WEDNESDAY DTSTART put the following
    // Monday in block 0 and emitted it — but that Monday belongs to the FIRST week, and
    // the next active week is the one after. A fortnightly review appeared one week
    // early, which is the version of this bug that gets someone to the wrong meeting.
    const wkst = rule.WKST ? DAYS[String(rule.WKST).trim().toUpperCase()] : 1;
    // An unreadable WKST moves the boundary somewhere unknown, and this reader does not
    // guess at a boundary any more than at a frequency.
    if (wkst === undefined) return null;

    const out = [];
    const excluded = new Set(event.exdates || []);
    const anchor = wallOf(frame);
    // How far DTSTART sits into its own WKST-delimited week. Adding it to the day offset
    // turns "days since DTSTART" into "days since the start of DTSTART's week", which is
    // what the week index has to be measured from.
    const intoWeek = (calendarAt(anchor, 0).dow - wkst + 7) % 7;
    // Days between candidate positions. A weekly rule with BYDAY has to look at every
    // day and decide, so its step is 1 and the INTERVAL is applied to the WEEK index
    // below — which is what keeps the alternating phase intact. Advancing such a rule
    // day-by-day and patching the week boundary afterwards lost track of which week
    // was active, and a fast-forward landing mid-week skipped the whole thing.
    const step = freq === 'DAILY' ? interval : (byDay && byDay.length ? 1 : 7 * interval);

    // COUNT is defined against the SERIES, so a counted rule is walked from DTSTART.
    // An uncounted one is fast-forwarded in WHOLE step multiples, which preserves both
    // the daily interval and the weekly phase because the offset stays a multiple.
    let offset = 0;
    if (count == null && from > start) {
      const approx = Math.floor((from - start) / 86400000);
      offset = Math.max(0, Math.floor(approx / step) - 1) * step;
    }

    let emitted = 0;
    let exhausted = false;
    const guardMax = count != null ? 20000 : 4000;
    let guard = 0;
    for (; guard < guardMax; guard++) {
      const cal = calendarAt(anchor, offset);
      const ms = instantAt(anchor, cal, frame);
      offsetStep: {
        if (ms === null) break offsetStep;          // nonexistent local time (DST gap)
        if (ms > hardUntil && (count == null || emitted >= (count || 0))) { exhausted = true; break; }
        // Whole weeks from the start of DTSTART's WKST week, so INTERVAL selects active
        // weeks against the boundary the rule names.
        const activeWeek = !byDay || !byDay.length
          || Math.floor((offset + intoWeek) / 7) % interval === 0;
        // The weekday of the event's OWN calendar, never the panel's.
        const dayMatches = !byDay || !byDay.length || byDay.includes(cal.dow);
        if (activeWeek && dayMatches) {
          emitted++;
          if (ms >= from && ms <= hardUntil && !excluded.has(ms)) out.push(ms);
        }
        if (ms > hardUntil) { exhausted = true; }
      }
      if (exhausted) break;
      if (count != null && emitted >= count) { exhausted = true; break; }
      offset += step;
    }
    // Hitting the safety cap is NOT "the series ended". Returning what we happened to
    // collect would claim a truncated answer is complete; refusing says so instead.
    if (!exhausted && guard >= guardMax) return null;
    return out;
  }

  /** Parse an ICS document into {events, dropped} — dropped counts VEVENTs whose
   *  recurrence this reader refuses to guess at. */
  function parse(text) {
    const lines = unfold(text).split('\n');
    const events = [];
    let cur = null;
    let nested = 0;      // depth of components nested INSIDE the current VEVENT
    for (const line of lines) {
      const trimmed = line.trim();
      // Component names are case-insensitive. Comparing the raw line meant a feed using
      // lowercase names passed the widget's (case-insensitive) BEGIN:VCALENDAR check and
      // then parsed as ZERO events — "Nothing scheduled" about a calendar full of them,
      // with nothing dropped and no error to show.
      const upper = trimmed.toUpperCase();
      if (upper === 'BEGIN:VEVENT') { cur = { exdates: [] }; nested = 0; continue; }
      if (upper === 'END:VEVENT') {
        // A VEVENT with no DTSTART is normally unusable, and one exception matters: a
        // CANCELLATION identifies the occurrence it removes with UID + RECURRENCE-ID and
        // may carry no DTSTART of its own, which is how an iCalendar object with a
        // METHOD calls a meeting off. Dropped here, reconciliation never saw it, the
        // parent never got the exclusion, and the tile kept advertising a meeting that
        // had been cancelled. It is kept only far enough to cancel — the display filter
        // at the end still requires a start, so it never becomes a candidate itself.
        if (cur && (cur.start || (cur.override && cur.overrideOf != null))) events.push(cur);
        cur = null;
        nested = 0;
        continue;
      }
      if (!cur) continue;
      // A VEVENT can CONTAIN components — VALARM, most commonly — and they have
      // properties with the same names. An email reminder carries its own SUMMARY, so
      // without this the event's title was overwritten by the alarm's subject and the
      // tile displayed "Calendar reminder" instead of the meeting. Depth rather than a
      // VALARM check, because the rule is "properties of the VEVENT itself", and the
      // next nested component to appear should not need this fixing again.
      if (upper.startsWith('BEGIN:')) { nested++; continue; }
      if (upper.startsWith('END:')) { if (nested > 0) nested--; continue; }
      if (nested > 0) continue;
      const colon = trimmed.indexOf(':');
      if (colon < 0) continue;
      const head = trimmed.slice(0, colon);
      const value = trimmed.slice(colon + 1);
      const semi = head.indexOf(';');
      const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
      const params = semi < 0 ? {} : parseParams(head.slice(semi + 1));

      if (name === 'DTSTART') cur.start = parseDate(value, params);
      else if (name === 'DTEND') cur.end = parseDate(value, params);
      else if (name === 'SUMMARY') cur.summary = unescapeText(value);
      else if (name === 'LOCATION') cur.location = unescapeText(value);
      else if (name === 'UID') cur.uid = value;
      else if (name === 'RRULE') cur.rrule = parseRRule(value);
      else if (name === 'RDATE') cur.hasRdate = true;
      // A cancelled override deletes its occurrence rather than moving it.
      else if (name === 'STATUS') cur.status = String(value || '').trim().toUpperCase();
      else if (name === 'EXDATE') {
        for (const one of value.split(',')) {
          const d = parseDate(one, params);
          if (d && d.ms != null) cur.exdates.push(d.ms);
        }
      }
      // RECURRENCE-ID means this VEVENT replaces ONE occurrence of a series. A real
      // export carries the recurring parent AND this child, so dropping only the child
      // leaves the parent still emitting the occurrence at its old time — the moved
      // meeting shown where it no longer is. The id is kept so it can be reconciled
      // against the parent below.
      else if (name === 'RECURRENCE-ID') {
        cur.override = true;
        cur.overrideRange = String((params && params.RANGE) || '').trim().toUpperCase();
        const d = parseDate(value, params);
        if (d && d.ms != null) cur.overrideOf = d.ms;
      }
    }
    // Reconcile over EVERY parsed component, including the startless cancellations kept
    // above — filtering to those with a start first was what discarded them before they
    // could cancel anything.
    const byUid = new Map();
    for (const e of events) if (e.uid && !e.override) byUid.set(e.uid, e);
    for (const e of events) {
      if (!e.override) continue;
      const parent = byUid.get(e.uid);
      if (!parent) continue;
      if (e.overrideRange === 'THISANDFUTURE') {
        // RANGE=THISANDFUTURE replaces the named occurrence AND every one after it — a
        // series rescheduled from a date forward, which is how "move our standup to
        // 10:30 from next week" is exported. Read as a single move, with the RANGE
        // parameter ignored, the parent went on emitting every LATER occurrence at the
        // obsolete time, so the tile presented the old schedule as current indefinitely.
        //
        // Implementing the semantics means truncating the parent at the override and
        // expanding the child's rule from there — but the child need carry no rule of
        // its own, so that last step is a guess. This reader's standing rule is to drop
        // what it cannot expand exactly and say so, and that is what happens here: the
        // parent is refused and counted. The child stays a candidate at its new time, so
        // the rescheduled occurrence is still shown; what is lost is the rest of the
        // series, which is the honest cost of not guessing at it.
        parent.unsupportedRange = true;
        continue;
      }
      // Fold the override into its parent as an exclusion, matched by UID. The parent
      // then skips that instant, so the occurrence disappears from its old slot instead
      // of appearing twice or appearing wrongly.
      if (e.overrideOf != null) parent.exdates.push(e.overrideOf);
    }
    // A CANCELLED child means "this occurrence is off", not "it moved". It has already
    // excluded the parent's slot above; keeping it as a candidate too would advertise
    // the very meeting the calendar says was called off. The start requirement is what
    // keeps a startless cancellation out of the candidate list now that it survives.
    return events.filter((e) => e.start && e.status !== 'CANCELLED');
  }

  /** Local midnight `days` days from the one `ms` falls in. Calendar arithmetic, not
   *  `ms + days * 86400000`: a local day is only 86,400,000 ms long on days without a
   *  DST transition, so the sum lands an hour off on either side of one. */
  function addLocalDays(ms, days) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return d.getTime();
  }

  /** Whole days an all-day event covers. DTEND is EXCLUSIVE (RFC 5545 §3.6.1), so a
   *  DTSTART of the 10th with DTEND of the 12th is TWO days — the 10th and the 11th —
   *  and reading it as three is the off-by-one that makes an event outlive its calendar.
   *  Absent, timed or nonsensical DTEND means the single-day form. Rounded because the
   *  two midnights can be an hour apart across a transition. */
  function allDaySpanDays(event) {
    const end = event.end;
    if (!end || !end.allDay || end.ms == null || event.start.ms == null) return 1;
    const days = Math.round((end.ms - event.start.ms) / 86400000);
    return days >= 1 ? days : 1;
  }

  /** The soonest occurrence at or after `from`. Returns {best, dropped, total}, where
   *  `best` carries `allDayEnd` — the instant a multi-day all-day occurrence stops being
   *  current — so the widget's expiry can agree with the window used to find it. */
  function next(text, from, lookaheadMs, opts) {
    const options = opts || {};
    const events = parse(text);
    const until = from + lookaheadMs;
    let best = null;
    let dropped = 0;
    for (const ev of events) {
      // An override is a real event at its NEW time — its old slot has already been
      // excluded from the parent above, so it can simply be read as an ordinary
      // one-off rather than thrown away. Dropping it was what left the moved meeting
      // invisible while the parent still advertised the time it moved from.
      if (options.ignoreAllDay && ev.start.allDay) continue;
      // An all-day event may be eligible from EARLIER than a timed one. It starts at
      // local midnight, so a window opening an hour before now excludes today's all-day
      // event from 01:00 onwards — a one-off vanishes into "Nothing scheduled" and a
      // repeat jumps to tomorrow, for the whole of the day it is actually on. The caller
      // supplies the earlier bound because only it knows what "today" means on the panel.
      //
      // A MULTI-DAY all-day event is still on for every day between DTSTART and DTEND,
      // and eligibility tested only the start — so a two-day conference disappeared from
      // the tile at midnight on its first day while it was still running, and vacations
      // and long holidays silently became one-day entries. Opening the window a further
      // `span - 1` days back is what keeps an occurrence already in progress eligible,
      // and because DTEND is exclusive it also stops being eligible on exactly the right
      // morning rather than one late.
      const span = ev.start.allDay ? allDaySpanDays(ev) : 1;
      const evFrom = (ev.start.allDay && options.allDayFrom !== undefined)
        ? addLocalDays(options.allDayFrom, -(span - 1)) : from;
      const hits = expand(ev, evFrom, until);
      if (hits === null) { dropped++; continue; }
      for (const ms of hits) {
        if (!best || ms < best.start) {
          best = { event: ev, start: ms, allDayEnd: ev.start.allDay ? addLocalDays(ms, span) : null };
        }
      }
    }
    return { best, dropped, total: events.length };
  }

  global.ICS = { parse, expand, next, parseDate, unfold };
})(window);
