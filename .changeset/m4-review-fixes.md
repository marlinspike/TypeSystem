---
"@typesys/engineer": minor
"@typesys/cli": patch
---

The engineering loop after its independent review (ADR-0071, amended).
`verify` passes a check only on the runtime's own answer, rebuilds from a
clean `dist/` with compiler options it owns, and runs each check against a
freshly started application. Mission specs are validated so that no
string becomes code, every check names a caller and something to assert,
and approves checks name an approval step. Plan reports checks on objects
that do not exist and callers no check covers. The MCP tools check real
paths against their root, and confine a host module given as a path. A
host that does not load is a `host-unavailable` diagnostic. `typesys
engineer` says to install the package only when it is missing.
