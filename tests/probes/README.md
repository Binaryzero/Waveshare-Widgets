# Diagnostic probes

Reproduction scripts written while diagnosing specific issues. **These are not CI, not
a suite, and nothing runs them automatically.** They are here because they encode real
diagnostic work — several of them establish the exact timing or state sequence that
makes a bug appear, which is the expensive half of fixing it and the half that was
otherwise living in a temp directory one container reset from being lost.

Treat them as evidence, not as tests:

- They pin line numbers and selectors from the tree as it was when they were written.
  Expect drift. A probe that no longer finds its target is stale, not a failing test.
- Several were written to fail against the build of the day and pass against a fix.
  Which direction a given probe expects is in its own header comment.
- They are not maintained by the sweep. If one rots, fix it when you next need it or
  delete it — do not let it block anything.

Run them the way the harnesses run:

```
NODE_PATH=/opt/node22/lib/node_modules CHROMIUM=/opt/pw-browsers/chromium \
  node tests/probes/<name>.js
```

## What is here, by the issue it was written for

| Probe | Issue |
|---|---|
| `gh-round1/2/3`, `gh-hang`, `gh-sched`, `gh-backoff-floor` | #170 — GitHub Queue follow-ups |
| `ha-probe`, `ha-round1..4`, `ha-bodystall` | #172 — a Home Assistant poll starting mid-command releases the action guard. `ha-round4` encodes the exact target timeline. |
| `ne-probe` | #180 — Next Event scheduling and rendering |
| `rest-round1..4` | #60, #176 — REST Value follow-ups |
| `kev-round2`, `kev-timers` | KEV retry and timer behaviour |
| `ollama-evict/round/switch/ttl` | Ollama model switching and TTL |
| `endpoints-hang/headverdict/rank/resize/slow` | Endpoints ranking and slow-response handling |
| `wow-probe2` | #25 — WoW panel |
| `probe206` | #206 — controls paging the panel |
| `addzone`, `addzone2`, `addzone3` | #86 — the free-space partition can hide a fit that exists |
| `tz-sweep`, `dst-check`, `dst-expiry` | ICS parsing across time zones and DST boundaries |

## Why not in `tests/harness/`

Everything in `tests/harness/` is expected to pass, is run by the sweep, and is
maintained. Mixing one-shot diagnostics in with that would either force them to be
maintained at the same standard — which is not worth it — or quietly erode what a green
harness run means. Keeping them separate lets both keep their meaning.
