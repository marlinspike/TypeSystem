# Pack archives

The demo domains as domain packs ([ADR-0059](../docs/adr/0059-domain-packs.md)),
the files an offline deployment receives and installs. They are generated
from the domains' manifests by `npm run packs` and checked for drift by
`npm run packs -- --check` (also a test). Do not edit them by hand: the
digest will no longer match.

```bash
typesys pack inspect packs/airforce-1.0.0.typesys-pack.json
```

These are unsigned; sign a release with `typesys pack sign`.
