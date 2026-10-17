# @typesys/cold-chain

The governed model over three independent cold-chain services
(`examples/services/shipment-tracker`, `sensor-hub`,
`pharmacy-inventory`), used by the reference application in
`examples/apps/cold-chain` (ADR-0087).

- **Types:** `coldchain.Site`, `Shipment`, `Reading`, `Excursion`, `Lot`, with
  optional relationships across the services (ADR-0072).
- **Actions:** `CloseExcursion` and `ReopenExcursion` (sensor hub);
  `QuarantineShipmentLots`, `ReleaseShipmentLots`, `QuarantineLot` and
  `ReleaseLot` (pharmacy inventory), each through that service's own
  credential (ADR-0076).
- **Policy:** a carrier's dispatcher reads only their own freight and no
  telemetry; an auditor reads and changes nothing; only quality assurance
  quarantines a single lot or signs off a disposition.
- **Classification:** `coldChainClassification` (PUBLIC < INTERNAL <
  CONFIDENTIAL); a lot's `unitCost` is CONFIDENTIAL.

`buildColdChainHost()` starts the three services in their own processes
unless given their URLs; `resolveColdChainIdentity` maps the demonstration
tokens to identities.
