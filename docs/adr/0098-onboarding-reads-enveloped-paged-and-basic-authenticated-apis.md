# 0098. Onboarding Reads Enveloped, Paged and Basic-Authenticated APIs

## Status

Accepted (2026-10-17). Found by onboarding the recall exchange in the
developer showcase's challenge (transcript
`docs/evidence/showcase-challenge/transcript/01-discover.txt`). Amends
ADR-0076 (onboarding) and ADR-0072 (the HTTP adapter). Implemented in
`packages/adapter-http/src/http-adapter.ts` (`record`, `list.pages`) and
`packages/onboard/src/sources.ts`, `build.ts`, `proposal.ts`. Proven by
`packages/adapter-http/test/http-enveloped.test.ts` and
`packages/onboard/test/onboard-enveloped.test.ts`.

## Context

The recall exchange's OpenAPI document describes a common shape the HTTP
adapter and onboarding did not handle. Every response is an envelope,
`{ "data": …, "meta": … }`; lists are numbered pages with
`meta.hasMore`; the client authenticates with HTTP Basic; and its response
schemas use `oneOf`. Onboarding proposed no Type at all: the get's schema
was a one-property envelope with no key, so nothing was recognized as an
entity, and the command's schema reference inside `oneOf` was never
resolved.

## Decision

The HTTP adapter takes `record`, a JSON Pointer that unwraps a get's
response, and `list.pages: { param, more, first? }` for numbered pages: it
asks for page `first` (default 1), then the next while the `more` flag is
true and the page held items, within `maxPages`. A mapping may not declare
both `next` (a cursor) and `pages`.

Onboarding recognizes a one-property envelope around a `$ref` as the
entity with that pointer, a page parameter beside a `hasMore`-like flag (at
the top level or one object down) as numbered pages, `http`/`basic` as
Basic auth (the plan names `<SOURCE>_CLIENT_ID` and `_CLIENT_SECRET`), and
inlines `oneOf`, `anyOf` and `allOf`. The page parameter is no longer
reported as an ambiguity.

## Consequences

The recall exchange onboards to one approved Type, its paged list reads
all six notices, and `onboard check` passes against the live service.
An envelope with more than one property around the record is still not
recognized; it is proposed as nothing, which the proposal says.
