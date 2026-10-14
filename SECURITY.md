# Security Policy

## Before you report

TypeSystem's security controls are tested in CI, by a mutation suite
(`npm run mutation`) and by independent adversarial reviews recorded in
[`docs/reviews/`](docs/reviews/). The packages are versioned 0.x and are
not yet published to npm, and the code has not had an external security
audit. [`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md) lists
the deployment decisions that remain yours, such as key management, TLS
and secrets.

Items documented there are **known deployment responsibilities, not
vulnerabilities**, so a report that restates one doesn't reveal anything
new. A report is valuable when it shows behaviour that contradicts what the
docs claim, or a weakness the docs don't already name.

## Supported versions

Every `@typesys/*` package is pre-1.0 (`0.x`) and nothing has been
published to a registry (ADR-0020). There are no maintained release
branches: security fixes land on `main`. If you have vendored or forked the
code, track `main` for fixes.

| Version | Supported |
|---|---|
| `main` (HEAD) | ✅ Fixes land here |
| Any tagged / published release | ❌ None exist yet |

## Reporting a vulnerability

**Please report privately — do not open a public issue for a suspected
vulnerability.**

Use GitHub's private vulnerability reporting: on the repository's
**Security** tab, choose **"Report a vulnerability"**. This opens a private
advisory visible only to you and the maintainers.

Please include, as far as you can:

- the affected package(s) and file(s), and the commit SHA you observed it on;
- a description of the issue and its impact (what an attacker gains);
- a minimal reproduction — a failing test, a `curl` against the HTTP
  transport, or a short script is ideal;
- any suggested remediation.

### What to expect

This is a small project, so response is best-effort rather than
SLA-backed. We aim to acknowledge a report within a week, agree on
severity and a fix approach with you, and credit you in the advisory and
the changeset unless you'd rather remain anonymous. Please give us a
reasonable chance to ship a fix before disclosing publicly.

## Scope

In scope: anything that lets a caller cross the one governed boundary the
architecture promises — reading an object, property, or relationship a
policy should deny; invoking an Action without passing its policy check;
escaping the query/Action input bounds (`InputValidator`); leaking a value
through provenance, an error message, a query filter/sort, or an
aggregation that policy should have redacted; or breaking the identity
resolution in `@typesys/auth-oidc`.

Out of scope: the documented production-readiness gaps
([`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md)), issues in
the example `domain-airforce` / `domain-hospital` domains that exist only
to demonstrate the architecture, and anything requiring a threat model or
deployment hardening the project explicitly hasn't done yet.
