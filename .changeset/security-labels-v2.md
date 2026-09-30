---
"@typesys/core": minor
---

Security labels v2 (ADR-0041). `ClassificationScheme` replaces `dominates(clearance, marking)` with `decide({ subject, markings, context })` — the whole subject, the whole label, and the action and resource — and `join(markings)`, the label of derived data. The runtime decides the join and every marking on its own, so a scheme's join can add restriction but never remove it, and fails closed on a join that throws or answers anything but a non-empty list of markings. Classification audit rows now carry `details.label` and the scheme's `details.reason`. `linearClassification`, `DEMO_LINEAR_CLASSIFICATION`, and `DENY_MARKED_DATA` implement the new interface; new `securityLabels({ levels, homeCountry, accreditation })` is a reference scheme modeling levels, compartments, `REL TO`/`NOFORN` releasability, CUI categories as their own regime, and system accreditation.
