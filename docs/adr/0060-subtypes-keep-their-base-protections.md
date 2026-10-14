# 0060. A Subtype Keeps Its Base's Protections

## Status

Accepted. Implemented in `@typesys/core`: `SemanticRegistry.registerType` now composes a subtype's `x-policy` and `x-provenance` with its base's.

Proven by:

- `packages/core/test/subtype-protections.test.ts`:
  - A subtype that names only an object policy withholds from a reader exactly what its base withholds: the officers-only value, the SECRET value, and the computed value derived from the officers-only one (ADR-0052). An officer still reads everything.
  - A subtype that names no object policy gets its base's, so the same readers are admitted and the rest refused.
  - A subtype may add a property policy or a marking where the base has none, and it applies.
  - A subtype that would replace an inherited property policy, an inherited property classification, or the base Type's classification is refused at registration.
  - The base Type's classification marks the subtype too.
- `packages/packs/test/packs.test.ts`: the `site.F16` specialization pack, which declares no policy of its own, gives the demo viewer an F-16 without its maintainer-only `maintenanceStatus`, its SECRET `deploymentLocation` or its withheld `readinessStatus`, and gives the maintainer all three.

Mutation-checked with six mutations, each failing at least one test:

- no inheritance at all (the old behavior);
- the object policy not inherited;
- an inherited property policy replaceable;
- an inherited classification replaceable;
- property markings not inherited;
- the Type marking not inherited.

## Context

Found while building domain packs (ADR-0059), whose way to specialize a domain is a Type that `extends` it. Registration composed a subtype's schema (`allOf` with the base), relationships, Actions and computed values, but not its `x-policy` or `x-provenance`. The runtime reads both from the subtype's own schema, so a subtype had only what it declared itself:

- **A subtype declaring nothing** was readable by no one, since an absent object policy is `default-deny`. This failed closed.
- **A subtype declaring only an object policy** exposed every protected value it inherited. Reproduced on the demo, `site.F16 extends airforce.Aircraft` with `objectPolicy: airforce.read-aircraft` gave the CUI-cleared viewer three values it does not get on the Aircraft itself:
  - `maintenanceStatus` (maintainer-only);
  - `deploymentLocation` (SECRET);
  - `readinessStatus` (computed from `maintenanceStatus`, withheld under ADR-0052).

Nothing in the demo domains extends a Type that carries a policy or a marking: core's base Types have neither. So no shipped behavior changes. The gap was in what the next author would write.

## Decision

**What a subtype inherits keeps the base's protections.** At registration:

- The base's property policies are merged into the subtype's.
- The base's per-property markings and Type marking are merged into the subtype's `x-provenance`.
- The base's object policy applies unless the subtype names its own. A subtype's objects are its own (a separate Type to adapters and policy), so its author may decide who reads them at all, but not who reads a value the base protects.

**A subtype may add, never replace.** A subtype may add a policy or a marking for a value the base leaves open, or for its own values. Restating the base's rule or marking is accepted.

Registration cannot tell whether a different rule or marking is tighter or looser:

- rules are opaque names to the registry;
- classification order belongs to the runtime's scheme (ADR-0032).

So naming a different one for an inherited value is refused with a message that says so. A subtype therefore cannot yet tighten an inherited value's rule; doing so needs a way to show the new rule implies the base's.

**The composition is stored.** The composed `x-policy` and `x-provenance` are written into the subtype's stored schema, as `allOf` already is. Any registry store, Postgres included, reads them back without recomputing.

## Consequences

- Extension is now safe to use for specialization: a subtype cannot widen access to anything it inherits, by accident or on purpose.
- Some subtypes registered before this change behave differently after it:
  - One that named its own object policy over a protected base now withholds the base's protected values from callers who could read them before. This is the fix, and it can surprise a consumer that relied on the leak.
  - One that named no policy becomes readable by the base's readers, where it was readable by no one.
  - One that restated a base value with a different rule or marking now fails to register.

  None of the demo or test domains did any of these.
- A computed value a subtype redefines can still release its inputs (ADR-0052). That is explicit, audited on every release, and unchanged here.
- Not done: proving a replacement rule or marking is strictly tighter, which would need the policy engine and classification scheme at registration time.

## Alternatives Considered

- **Resolve the base's protections at read time.** Equivalent for reads, but every enforcement path (filters, plans, aggregation, classification checks) would need to walk the base chain, and a store reading a Type back would depend on its base being present. Composing once at registration keeps one place to look.
- **Let a subtype override freely.** Matches how `x-relationships` and `x-computed` compose (own wins), but those carry no access decision. For protections, "own wins" is exactly the leak.
- **Refuse any subtype of a protected Type that declares its own `x-policy`.** Safe but blunt: it would forbid a subtype from protecting its own new values.

## Amendments

**Amended 2026-10-14** (adversarial review, `packages/core/test/pressure-core-enforcement.test.ts`):
protections were composed only when the subtype registered, so a later
version of the base that added a property policy or marking left every
existing subtype without it. Registering a version that becomes the base's
current one now re-derives the protections of every registered subtype (each
version, and their own subtypes in turn): what a subtype inherited from the
previous base follows the new one, its own additions stay, and a protection
the new base drops is kept, so nothing is loosened by a base upgrade. A new
base version that would replace a subtype's own rule or marking is refused
before anything is stored, as the subtype's registration would be.
