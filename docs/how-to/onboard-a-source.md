# Onboard an existing database or service

`@typesys/onboard` (ADR-0076) turns a PostgreSQL schema, an OpenAPI
service or a set of JSON Schemas into TypeSystem Types, relationships,
Actions, mappings and adapters. It proposes, from the sources' own
metadata; you approve; it builds and verifies only what you approved.
A development model can help with names, undeclared relationships and
sensitive fields, but nothing it says is used without being checked
against the evidence and approved by you.

## See it work

With a PostgreSQL database you can create a schema `mx` in:

```sh
npm run build
DATABASE_URL=postgres://user@localhost/scratch npm run onboard:demo
```

The demonstration loads `examples/onboarding/mxdb.sql` (a squadron
maintenance database with terse legacy names, codes, one undeclared
reference and personal data), starts the crew roster service from
`examples/services/crew-roster/`, and onboards both together. It uses the
committed agent-mode answer in `examples/onboarding/recordings/` and the
review in `examples/onboarding/review.json`, then reads the result
through the runtime, runs the generated checks, adds a column to the
database and onboards again with no model: everything approved stays as
approved, and only the new column is pending.

## Do it with the CLI

Collect evidence, one source at a time, into one file. A database's
connection string is read from the environment variable you name:

```sh
export MXDB_URL=postgres://reader@db.internal/mxdb
typesys onboard collect --postgres MXDB_URL --schema mx --source mxdb --system MXDB --out sources.json
typesys onboard collect --openapi https://roster.internal/openapi.json --source roster --out sources.json
```

The path of an OpenAPI document's first server (`/roster` for
`https://svc.example/roster`) is kept and put before every request path.
The deployment's base URL gives the origin, and a client secret is posted
only to that origin. If the metadata itself is classified, label it with
`--marking SECRET` on `request` and `propose`. Marked metadata is then
sent only to a configured model whose audience may receive it, never to a
coding agent.

Only catalog metadata is read: no rows.

### Refine with a model, or without one

Without a model, `propose` uses the deterministic baseline:

```sh
typesys onboard propose sources.json --domain mx --out onboarding/
```

With a configured development model (ADR-0074), local or hosted:

```sh
typesys onboard propose sources.json --domain mx --model local-coder --llm-config typesys.llm.json --out onboarding/
```

In agent mode, the coding agent you are working with is the model. Give
it the request, and give its answer back:

```sh
typesys onboard request sources.json --domain mx --out request.txt
# the agent reads request.txt and writes refinement.json
typesys onboard propose sources.json --domain mx --answer refinement.json --out onboarding/
```

`onboarding/recording.json` keeps the answer against the exact request,
so the run can be repeated without the agent; if the sources change, the
recording no longer answers and the request must be answered again.

Anything the model proposed that the evidence does not support (an id
that does not exist, a reference to a column that is not a key, a
marking no cited text states, an attempt to remove a protection) is
listed as refused and not applied.

### Review

`propose` writes `proposal.json` and `pending.json`. Nothing is approved
until you say so:

```sh
typesys onboard review onboarding/ --review review.json --by "J. Rivera" \
  --rename 'type:pg:mxdb/mx.acft=Airframe' \
  --reject 'relationship:openapi:roster#/components/schemas/Member/properties/assigned_tail->pg:mxdb/mx.acft.tail_no=hand-typed tail numbers' \
  --accept-rest
typesys onboard propose sources.json --domain mx --answer refinement.json --review review.json --out onboarding/
```

Each decision is pinned to the evidence it was made on. Commit
`review.json` and `approved.json`. When a source changes, run `collect`
and `propose` again with `--review review.json --approved
onboarding/approved.json --previous onboarding/pack.json --version
1.1.0`: approved items whose evidence did not change stay exactly as
approved, changed ones are asked about again, and the new pack is checked
against the old one for compatibility.

Actions are never approved without a decision. Sensitive fields protect
from the first run, until you reject the flag.

### Write the policies, then check against the live sources

`propose` prints the policy rules the domain needs, by name only:
`mx.read-aircraft`, `mx.personal-name`, `mx.invoke-change-duty-status`.
Onboarding never writes their bodies: see
[add a policy rule](add-a-policy-rule.md).

```sh
export ROSTER_BASE_URL=https://roster.internal ROSTER_CLIENT_ID=... ROSTER_CLIENT_SECRET=...
typesys onboard check onboarding/
```

`check` reads each Type, checks every value against its schema, follows
every relationship, and confirms each sensitive property is withheld
from a caller without its rule and each marked property from a caller
cleared below it. A check the data cannot decide (no record holds the
value, or the service withholds it from the onboarding client) is
reported `inconclusive`, not passed.

`adapters.json` describes the adapters by environment variable; build
them in your host with `adaptersFor(plans, { secret, pool })`, and
install `pack.json` with the rest of your packs.
