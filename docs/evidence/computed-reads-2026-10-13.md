# Coalesced computed reads, 2026-10-13

Slice 10a of the [roadmap](../roadmap.md), [ADR-0062](../adr/0062-coalesced-computed-reads.md).
The baseline ([`baseline-2026-10-13.md`](baseline-2026-10-13.md)) named
`needsAttention` as the query hotspot: it calls the maintenance system
once or twice per aircraft.

## Method

`npx tsx scripts/benchmark-computed-reads.ts`:

- **Data.** 200 aircraft (60% operational) with up to two maintenance events each, about 60% of them with a work order, half of those open.
- **Read.** One page with `needsAttention`, read as the maintainer.
- **Runs.** 5 warm-up reads, then 100 timed reads (no latency) or 20 (with latency).
- **Counted.** The calls reaching the maintenance adapter, counted below the runtime.
- **Environment.** Node 22, one process, default `maxConcurrency` (20).

## Results, two runs

| Latency per call | Mode | Calls per page | p50 ms | p95 ms |
|---|---|---|---|---|
| 0 ms | direct | 225 | 42.7, 43.7 | 59.3, 54.6 |
| 0 ms | coalesce | 14 | 31.3, 30.1 | 41.9, 44.2 |
| 2 ms | direct | 225 | 48.7, 53.5 | 56.0, 74.1 |
| 2 ms | coalesce | 12 | 42.2, 43.1 | 46.1, 49.1 |
| 10 ms | direct | 225 | 134.1, 135.2 | 137.9, 143.0 |
| 10 ms | coalesce | 12, 13 | 109.4, 109.1 | 148.1, 118.5 |

The calls fall by about 16 times. Time falls by about 20% to 30%, because
round trips, not calls, set the wall time: at most `maxConcurrency` objects
are resolved at once, so a page still takes about as many bursts.

## Where it does not help

In `npm run benchmark`'s "query + filter (200 rows)" case, the aircraft
have no maintenance events, so every lookup finds nothing at no cost.
There, coalescing is slower. Two runs:

| Mode | p50 ms | p95 ms |
|---|---|---|
| direct | 15.8, 15.4 | 22.9, 21.6 |
| coalesce | 17.6, 18.7 | 26.8, 27.3 |

That is why it is an option, off by default (ADR-0062).

## First attempt, discarded

Giving each computation its own copy of a shared answer (`structuredClone`
per caller) made the 0 ms case 125 ms at p50, three times slower than
direct. A copy per read, frozen and shared, replaced it.

## Equivalence

`packages/domain-airforce/test/computed-read-coalescing.test.ts` compares
every page of five queries, for three callers, over three generated fleets.
Every answer and every refusal is identical in both modes. Thirteen
mutations of the coalescer were each caught (ADR-0062).
