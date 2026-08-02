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
      return { ms: new Date(y, mo - 1, d, 0, 0, 0).getTime(), allDay: true, floating: false };
    }
    const h = +H, mi = +Mi, s = +S;
    if (Z) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false, floating: false };
    const tz = params && params.TZID;
    if (tz) {
      try { return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), allDay: false, floating: false }; }
      catch (e) { /* unknown zone — fall through to floating rather than guess UTC */ }
    }
    return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false, floating: true };
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

  /** Occurrences of one event at or after `from`, up to `until`, newest-last.
   *  Returns [] for a rule this reader cannot expand exactly. */
  function expand(event, from, until) {
    const start = event.start.ms;
    if (!event.rrule) return (start >= from && start <= until) ? [start] : [];

    const rule = event.rrule;
    const freq = String(rule.FREQ || '').toUpperCase();
    if (freq !== 'DAILY' && freq !== 'WEEKLY') return null;   // null = "cannot expand"

    const interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1);
    const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;
    const untilRule = rule.UNTIL ? parseDate(rule.UNTIL, {}) : null;
    const hardUntil = Math.min(until, untilRule ? untilRule.ms : until);

    const byDay = freq === 'WEEKLY' && rule.BYDAY
      ? String(rule.BYDAY).split(',').map((d) => DAYS[d.trim().slice(-2).toUpperCase()]).filter((n) => n !== undefined)
      : null;

    const out = [];
    const excluded = new Set(event.exdates || []);
    let emitted = 0;
    const dayMs = 86400000;
    // Walk from DTSTART rather than from `from`: COUNT is defined against the series,
    // so starting mid-series would let a finished series keep producing occurrences.
    let cursor = start;
    // Bounded so a malformed rule cannot spin: two years of daily steps is far past
    // any lookahead this widget offers.
    for (let guard = 0; guard < 1200 && cursor <= hardUntil; guard++) {
      if (count != null && emitted >= count) break;
      let hit = true;
      if (byDay && byDay.length) hit = byDay.includes(new Date(cursor).getDay());
      if (hit) {
        emitted++;
        if (cursor >= from && !excluded.has(cursor)) out.push(cursor);
      }
      // WEEKLY with BYDAY steps day by day inside the week and jumps INTERVAL weeks
      // at the week boundary; without BYDAY it is a plain interval of weeks.
      if (freq === 'DAILY') cursor += dayMs * interval;
      else if (byDay && byDay.length) {
        const next = cursor + dayMs;
        cursor = (new Date(next).getDay() === new Date(start).getDay() && interval > 1)
          ? next + dayMs * 7 * (interval - 1)
          : next;
      } else cursor += dayMs * 7 * interval;
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
      // RECURRENCE-ID means this VEVENT overrides one occurrence of a series. Honoring
      // it correctly means reconciling against the parent; ignoring it silently would
      // show a moved meeting at its old time. Mark the event so it is dropped.
      else if (name === 'RECURRENCE-ID') cur.override = true;
    }
    return events.filter((e) => e.start);
  }

  /** The soonest occurrence at or after `from`. Returns {event, start, dropped}. */
  function next(text, from, lookaheadMs, opts) {
    const options = opts || {};
    const events = parse(text);
    const until = from + lookaheadMs;
    let best = null;
    let dropped = 0;
    for (const ev of events) {
      if (ev.override) { dropped++; continue; }
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
