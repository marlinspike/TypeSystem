# 0118. A Development Deployment Is Promoted

## Status

Accepted (2026-11-04). Implemented in `packages/host/src/promote.ts` and
`typesys deploy promote` in `packages/host/src/cli.ts`. Proven by
`packages/host/test/promote.test.ts`.

## Context

`typesys init --from postgres` writes a development deployment: a demo, with
fixed tokens and an audit trail in memory. Making it shareable was a hand edit
of identity, `demo` and `state`, with a signing key made separately; the
assessment found most of that edit was where a newcomer stopped.

## Decision

`typesys deploy promote <dev.deployment.json> --issuer <url|ENV> --audience
<aud|ENV>` writes `<name>.shared.deployment.json` beside it, changing only what
sharing needs:

- `demo` is removed and identity is OpenID Connect (an argument shaped like an
  environment variable name becomes a `$env` reference), with
  `rolesClaim` (default `roles`) and a `roleMap` listing every role the
  policies use, to be given the provider's names.
- `state.audit` is Postgres with signed checkpoints: the URL from the secret
  `TYPESYS_STATE_URL` and the signing key from `TYPESYS_AUDIT_SIGNING_KEY`
  unless named otherwise. A deployment with applications also gets a Postgres
  workflow journal.
- An Ed25519 key pair is made: the public half in `verifyKeys`, the private
  half in `secrets/<keyId>.private.pem` (mode 600, beside a `.gitignore`).

It refuses to overwrite either file without `--force`, and prints the secrets
to provide and the next commands (`deploy check`, `migrate`, `deploy package`).

## Consequences

Models, sources, policies and personas are untouched, so `typesys deploy check
dev shared` shows exactly what promoting changes. The policy tests written for
development still apply.
