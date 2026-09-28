# Why TypeS?

## The problem, in one sentence

Your applications and your AI agents both need to ask "give me this
Aircraft, its components, where that data came from, and what I'm allowed
to do to it" — without either of them needing to know that the answer
actually lives across a Postgres database, a legacy REST API, and a
message queue.

## Use TypeS when...

- **You have (or will have) more than one physical system** that need to
  present a single, coherent object model to consumers. One database
  behind one app doesn't need this — see "Don't use TypeS when," below.
- **Authorization has to be consistent everywhere a piece of data is
  read**, not re-implemented per UI, per API endpoint, per agent tool. The
  policy engine sits at one boundary (`SemanticRuntime`) that every
  consumer goes through — a human application and an AI agent get
  *identical* enforcement, proven by
  [ADR-0012](adr/0012-mcp-mapping-and-stateless-identity.md)'s own test
  (two different bearer tokens, two different outcomes, same connection).
- **You need to know where a value came from**, not just what it is —
  regulated industries, DoD/federal environments, or anywhere "trust me"
  isn't an acceptable answer for a number a decision gets made on. See
  [ADR-0008](adr/0008-provenance-model.md).
- **You want an AI agent to discover and act on your domain safely**,
  without hand-writing a tool schema per backend and re-deriving
  authorization logic inside the agent layer. The MCP server
  (`packages/mcp-server`) is generic over whatever you register — see
  [`for-agents.md`](for-agents.md).
- **You're going to add domains for years**, and don't want every new one
  to require touching a shared core. A domain package
  (`packages/domain-airforce` is the reference example) is added, never
  edited into — see [ADR-0013](adr/0013-domain-packaging.md) and
  [`developer-guide/adding-a-domain.md`](developer-guide/adding-a-domain.md).

## Don't use TypeS when...

- **You have one database and one application talking to it directly.**
  An ORM (Prisma, Drizzle, TypeORM) is simpler, faster to write, and has
  no canonical-layer overhead to justify. TypeS's entire value proposition
  is unifying *multiple* physical systems behind one model — with one
  system, there's nothing to unify.
- **You need a mature, battle-tested 1.0 product today.** This is a
  reference implementation of a real architecture, not a product with a
  release history. Read [`docs/completeness.md`](completeness.md) for
  exactly what's proven-in-tests versus a documented, not-yet-built
  extension point, and
  [`docs/PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md) for the
  specific, ranked list of what closing the gap to real production
  traffic would actually take, before betting production traffic on it.
- **Sub-millisecond, zero-indirection latency is the whole point.** Every
  layer here — policy check, audit write, provenance tracking — is real
  work done on every call. It's fast enough for the workloads it was
  built for, and ADR-0016 adds a real cache for the properties that need
  one, but it will never be as fast as calling your database directly.

## How this compares to the obvious alternatives

**A hand-rolled BFF / facade layer.** This is what most teams build
instead — and TypeS is, honestly, a more principled version of exactly
that instinct. The difference is that policy, provenance, versioning, and
agent-safety are built into the layer once, as first-class concepts with
their own contracts (see [`semantic-meta-model.md`](semantic-meta-model.md)),
instead of accumulating ad hoc in whichever facade code your team wrote
under deadline. You still write adapters either way; here, an adapter is
the *only* thing you write per backend.

**GraphQL / Apollo Federation.** A legitimate, more mature choice if your
problem really is "stitch several GraphQL/REST APIs into one schema" and
nothing more. TypeS's query layer was deliberately *not* built on GraphQL
([ADR-0011](adr/0011-query-dsl-not-graphql.md)) because federation
solves schema unification, not policy-as-a-first-class-boundary,
provenance, or governed Actions distinct from queries — those are this
project's actual center of gravity. If you don't need any of that, GraphQL
federation is probably the better-supported answer.

**Palantir Ontology / C3 AI Type System, conceptually.** Similar
ambition — a canonical semantic layer between systems and consumers — but
both are proprietary platforms you adopt wholesale. TypeS is small,
built on open standards (JSON Schema 2020-12, MCP, OAuth/OIDC), and yours:
read every line of it, fork it, replace any single piece (the policy
engine, the registry store, an adapter) without asking anyone.

**Just giving an agent direct database/API access.** Works until you need
the agent's read to be policy-scoped the same way a human's is, or until
two agents (or an agent and a human) disagree about what a field means
because there's no shared, versioned Type definition backing either of
them. TypeS's MCP surface is the same governed boundary a human
application uses — see [`for-agents.md`](for-agents.md) — not a second,
parallel access path with its own rules.

## The core invariant, restated

A consumer — human or agent — can say:

> Give me Aircraft AF86-0147, its components, its readiness, its
> provenance, and the actions I am permitted to perform.

without knowing what database contains it, which API owns it, how many
source systems contributed to it, or how the underlying action actually
executes. Everything else in this codebase exists to make that sentence
true and keep it true as the system grows.
