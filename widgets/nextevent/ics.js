/* Minimal ICS reader, bundled because the sandbox has no CDN and no shared runtime.
 *
 * Scope is deliberate and documented in the widget's README section: it reads VEVENTs
 * and expands DAILY and WEEKLY recurrences. Anything it cannot expand EXACTLY it drops
 * and counts, because on a glanceable panel a wrong time is worse than no time — a
 * monthly standup rendered a week late is a meeting missed with confidence.
 *
 * Supported:
 *   DTSTART / DTEND, with VALUE=DATE (all-day), a TZID, a trailing Z, or floating
 *   SUMMARY, LOCATION, UID
 *   RRULE: FREQ=DAILY|WEEKLY, INTERVAL, COUNT, UNTIL, BYDAY (weekly)
 *   EXDATE (excluded occurrences)
 * Dropped (counted, never guessed):
 *   FREQ=MONTHLY|YEARLY|HOURLY|MINUTELY|SECONDLY, BYSETPOS, BYMONTHDAY, RDATE,
 *   RECURRENCE-ID overrides
 */
(function (global) {
  'use strict';

  const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  // RFC 5545 line folding: a continuation starts with a space or tab and belongs to
  // the previous line. Unfold before anything else or a long SUMMARY parses as junk.
  function unfold(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  }

  // What time is `wall clock in this zone` in UTC? Intl knows every IANA zone the
  // browser ships, which is how a TZID is honored without bundling a tz database.
  // Two passes converge across a DST edge, where the first guess can land in the
  // wrong offset.
  function tzOffsetMs(utcMs, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const map = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
    const asUtc = Date.UTC(+map.year, +map.month - 1, +map.day, (+map.hour) % 24, +map.minute, +map.second);
    return asUtc - utcMs;
  }

  function zonedToUtc(y, mo, d, h, mi, s, tz) {
    const naive = Date.UTC(y, mo - 1, d, h, mi, s);
    let guess = naive;
    for (let i = 0; i < 2; i++) guess = naive - tzOffsetMs(guess, tz);
    return guess;
  }

  function partsInZone(utcMs, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const m = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) m[p.type] = p.value;
    return { y: +m.year, mo: +m.month, d: +m.day, h: (+m.hour) % 24, mi: +m.minute, s: +m.second };
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
  function instantAt(anchor, dayOffset, frame) {
    const shifted = new Date(Date.UTC(anchor.y, anchor.mo - 1, anchor.d + dayOffset));
    const y = shifted.getUTCFullYear(), mo = shifted.getUTCMonth() + 1, d = shifted.getUTCDate();
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
      catch (e) { /* unknown zone — fall through to floating rather than guess UTC */ }
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

  function unescapeText(s) {
    return String(s || '')
      .replace(/\\n/gi, ' ')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\')
      .trim();
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
  const KNOWN_RRULE = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY']);

  /** Occurrences of one event at or after `from`, up to `until`, newest-last.
   *  Returns null for a rule this reader cannot expand EXACTLY. */
  function expand(event, from, until) {
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
    const hardUntil = Math.min(until, untilRule ? untilRule.ms : until);

    const byDay = freq === 'WEEKLY' && rule.BYDAY
      ? String(rule.BYDAY).split(',').map((d) => DAYS[d.trim().slice(-2).toUpperCase()]).filter((n) => n !== undefined)
      : null;

    const out = [];
    const excluded = new Set(event.exdates || []);
    const anchor = wallOf(frame);
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
      const ms = instantAt(anchor, offset, frame);
      offsetStep: {
        if (ms === null) break offsetStep;          // nonexistent local time (DST gap)
        if (ms > hardUntil && (count == null || emitted >= (count || 0))) { exhausted = true; break; }
        // The week index is measured in whole weeks from DTSTART, so INTERVAL selects
        // active weeks directly instead of being inferred at a day boundary.
        const activeWeek = !byDay || !byDay.length || Math.floor(offset / 7) % interval === 0;
        const dayMatches = !byDay || !byDay.length || byDay.includes(new Date(ms).getDay());
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
        if (cur && cur.start) events.push(cur);
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
          if (d) cur.exdates.push(d.ms);
        }
      }
      // RECURRENCE-ID means this VEVENT replaces ONE occurrence of a series. A real
      // export carries the recurring parent AND this child, so dropping only the child
      // leaves the parent still emitting the occurrence at its old time — the moved
      // meeting shown where it no longer is. The id is kept so it can be reconciled
      // against the parent below.
      else if (name === 'RECURRENCE-ID') {
        cur.override = true;
        const d = parseDate(value, params);
        if (d) cur.overrideOf = d.ms;
      }
    }
    const kept = events.filter((e) => e.start);
    // Fold each override into its parent as an exclusion, matched by UID. The parent
    // then skips that instant and the child is dropped, so the occurrence disappears
    // from its old slot instead of appearing twice or appearing wrongly.
    const byUid = new Map();
    for (const e of kept) if (e.uid && !e.override) byUid.set(e.uid, e);
    for (const e of kept) {
      if (!e.override || e.overrideOf == null) continue;
      const parent = byUid.get(e.uid);
      if (parent) parent.exdates.push(e.overrideOf);
    }
    // A CANCELLED child means "this occurrence is off", not "it moved". It has already
    // excluded the parent's slot above; keeping it as a candidate too would advertise
    // the very meeting the calendar says was called off.
    return kept.filter((e) => e.status !== 'CANCELLED');
  }

  /** The soonest occurrence at or after `from`. Returns {event, start, dropped}. */
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
      const evFrom = (ev.start.allDay && options.allDayFrom !== undefined)
        ? options.allDayFrom : from;
      const hits = expand(ev, evFrom, until);
      if (hits === null) { dropped++; continue; }
      for (const ms of hits) {
        if (!best || ms < best.start) best = { event: ev, start: ms };
      }
    }
    return { best, dropped, total: events.length };
  }

  global.ICS = { parse, expand, next, parseDate, unfold };
})(window);
