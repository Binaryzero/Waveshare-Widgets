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

  /** Add `n` days to an instant, PRESERVING WALL-CLOCK TIME in the event's own frame.
   *
   * `ms + n * 86400000` is wrong for anything but a UTC (`Z`) time, because a day is
   * not always 86400 seconds where the event lives. A 09:00 America/New_York daily
   * event stepped that way becomes 10:00 the morning after the spring transition and
   * stays an hour wrong until autumn — a meeting displayed at a time it does not
   * happen, which is the one thing this reader is not allowed to do. */
  function addDays(ms, n, frame) {
    if (!n) return ms;
    if (frame && frame.tz) {
      const p = partsInZone(ms, frame.tz);
      return zonedToUtc(p.y, p.mo, p.d + n, p.h, p.mi, p.s, frame.tz);
    }
    if (frame && (frame.floating || frame.allDay)) {
      // Floating and all-day are local wall clock by definition; Date's local
      // arithmetic already preserves it across a transition.
      const d = new Date(ms);
      d.setDate(d.getDate() + n);
      return d.getTime();
    }
    return ms + n * 86400000;   // a Z time is an absolute instant — UTC has no DST
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
  // BYSETPOS, BYMONTH, BYWEEKNO, BYHOUR — CONSTRAINS the series, so ignoring it
  // produces more occurrences than the rule describes rather than fewer.
  // `FREQ=DAILY;BYMONTHDAY=15` means the 15th of each month; ignoring BYMONTHDAY
  // renders it as every single day. Unknown parts are refused, not skipped.
  const KNOWN_RRULE = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST']);

  /** Occurrences of one event at or after `from`, up to `until`, newest-last.
   *  Returns null for a rule this reader cannot expand EXACTLY. */
  function expand(event, from, until) {
    const start = event.start.ms;
    const frame = event.start;
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
    const stepDays = freq === 'DAILY' ? interval : (byDay && byDay.length ? 1 : 7 * interval);
    const dayMs = 86400000;

    // Where to start walking. COUNT is defined against the SERIES, so a counted rule
    // must be walked from DTSTART or a finished series would keep producing — but an
    // UNCOUNTED one can be fast-forwarded, and has to be: a daily standup running
    // since 2020 needs ~2,400 steps to reach today, and a fixed guard walked from
    // DTSTART simply gave up and reported nothing scheduled. The event vanished while
    // the widget said the calendar was empty, which is the failure this reader exists
    // to prevent, wearing a different hat.
    let cursor = start;
    let emitted = 0;
    if (count == null && from > start) {
      const approxSteps = Math.floor((from - start) / (dayMs * stepDays));
      if (approxSteps > 0) cursor = addDays(start, approxSteps * stepDays, frame);
      // Nudge back over a DST-induced overshoot so nothing between here and `from`
      // is skipped; bounded, since the approximation is at most a day or two out.
      for (let back = 0; back < 4 && cursor > from; back++) cursor = addDays(cursor, -stepDays, frame);
    }

    // Guard scales with what the rule can legitimately produce: a COUNT series is
    // bounded by COUNT, an uncounted one is now walked from near `from`.
    const guardMax = count != null ? Math.min(count + 1, 10000) : 1200;
    for (let guard = 0; guard < guardMax && cursor <= hardUntil; guard++) {
      if (count != null && emitted >= count) break;
      let hit = true;
      if (byDay && byDay.length) hit = byDay.includes(new Date(cursor).getDay());
      if (hit) {
        emitted++;
        if (cursor >= from && !excluded.has(cursor)) out.push(cursor);
      }
      // WEEKLY with BYDAY steps day by day inside the week and jumps INTERVAL weeks
      // at the week boundary; without BYDAY it is a plain interval of weeks. Every
      // step goes through addDays so the wall clock survives a DST transition.
      if (freq === 'DAILY') cursor = addDays(cursor, interval, frame);
      else if (byDay && byDay.length) {
        const next = addDays(cursor, 1, frame);
        cursor = (new Date(next).getDay() === new Date(start).getDay() && interval > 1)
          ? addDays(next, 7 * (interval - 1), frame)
          : next;
      } else cursor = addDays(cursor, 7 * interval, frame);
    }
    return out;
  }

  /** Parse an ICS document into {events, dropped} — dropped counts VEVENTs whose
   *  recurrence this reader refuses to guess at. */
  function parse(text) {
    const lines = unfold(text).split('\n');
    const events = [];
    let cur = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
      if (trimmed === 'END:VEVENT') {
        if (cur && cur.start) events.push(cur);
        cur = null;
        continue;
      }
      if (!cur) continue;
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
    return kept;
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
      const hits = expand(ev, from, until);
      if (hits === null) { dropped++; continue; }
      for (const ms of hits) {
        if (!best || ms < best.start) best = { event: ev, start: ms };
      }
    }
    return { best, dropped, total: events.length };
  }

  global.ICS = { parse, expand, next, parseDate, unfold };
})(window);
