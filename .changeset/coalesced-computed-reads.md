---
"@typesys/core": minor
---

Coalesced computed reads (ADR-0062). A new runtime option, `computedReads: "coalesce"` (default `"direct"`), makes computed properties' adapter reads within one request share identical calls and batch concurrent equality lookups into one `in` query, split back per value where the adapter filters that property exactly. Computations receive the same answers, frozen. On the airforce demo it cuts the maintenance calls for a 200-aircraft page from 225 to 12 to 14; `scripts/benchmark-computed-reads.ts` measures it.
