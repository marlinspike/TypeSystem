# Changesets

This directory (and this file) is maintained by [changesets](https://github.com/changesets/changesets).
Do not delete `config.json` — it is used to configure this project.

## Adding a changeset

```bash
npx changeset
```

Prompts for which of `@typesys/*`'s publishable packages changed and
whether the bump is major/minor/patch, then writes a markdown file here
describing the change. Commit it alongside your code change — one
changeset per PR is the norm.

## Versioning and publishing

See [`docs/adr/0020-publish-infrastructure.md`](../docs/adr/0020-publish-infrastructure.md)
for how this repo actually uses changesets: `npx changeset version` bumps
package versions and writes CHANGELOGs from the accumulated changesets;
`.github/workflows/release.yml` runs that (and, only if `NPM_TOKEN` is
configured, `npx changeset publish`) automatically on `main`. No token is
configured in this repository's own CI, so the publish step in that
workflow cannot actually publish anything — see the ADR for why that's
deliberate.
