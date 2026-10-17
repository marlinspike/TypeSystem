# Recall response

Written 2026-10-17 by the enterprise architect for the cold chain, before
any application for it existed.

Manufacturers post their recall notices to an industry recall exchange, a
system our distribution business subscribes to but does not own. Today a
coordinator reads each notice, looks our lots up by hand in the pharmacy
inventory and the shipment tracker, phones quality assurance, quarantines
lots one by one, and types an effectiveness response into the exchange.
We want one governed recall response instead.

A logistics coordinator or a quality assurance pharmacist asks to respond
to a notice. Quality assurance signs the response off, and never the person
who asked for it. Only once it is signed off are our affected lots
quarantined in the pharmacy inventory and our response filed with the
exchange; nothing is held, and nothing is sent to the manufacturer, before
that. A notice the manufacturer has terminated, a notice we have already
answered, and a notice that names one of our lot numbers under a different
product than the lot is in our inventory cannot be answered: the request
fails, and nothing changes anywhere.

## What it runs on

- The cold chain host in `@typesys/cold-chain`: `buildColdChainHost()`
  builds it and starts the shipment tracker, the sensor hub and the pharmacy
  inventory (in `examples/services/`), and `resolveColdChainIdentity(token)`
  turns the existing demo tokens into people. Its `coldchain.Lot` (the
  pharmacy inventory's lots: `status` is `available`, `in-transit`,
  `quarantined` or `destroyed`; `holdReason`; `doses`; `ndc`;
  `shipmentId`) and `coldchain.Shipment` (the tracker's shipments:
  `status` is `in-transit`, `delivered` or `held`) are used as they are.
  The inventory key the host holds by default may write.
- The recall exchange, a fourth independent service with no TypeSystem code
  in it: `examples/services/recall-exchange/server.mjs` (started with
  `node` and `PORT=0`, it prints `recall-exchange on http://127.0.0.1:<port>`;
  it also exports `createRecallExchange()`), described by
  `examples/services/recall-exchange/openapi.json`. Each copy starts with
  the same notices. It authenticates by HTTP Basic: our distributor client
  is `coldchain-distributor` with secret `rx-exchange-2026` (reads every
  notice, files responses); `coldchain-viewer` / `rx-view-only` reads
  public notices only and may not respond. It writes NDCs as eleven digits
  without hyphens; the pharmacy inventory writes them hyphenated. A lot on
  a notice is named by the same lot number the pharmacy inventory uses, and
  a notice lists every lot the manufacturer recalled, including lots we
  never held.

## Names the application must use

- The workflow is `coldchain.RespondToRecall`, with the input `recallId`
  (the exchange's recall number, e.g. `RCL-26-0412`).
- Its approval step is `qaSignoff`.
- A notice is read as the Type `coldchain.Recall`, its object id the recall
  number, with these fields:

| Field | Meaning |
|---|---|
| `firm` | the issuing manufacturer |
| `product` | the product name |
| `ndc` | the NDC as the exchange writes it |
| `recallClass` | `I`, `II` or `III` |
| `lifecycle` | `active` or `terminated` |
| `embargoed` | `true` while the manufacturer has not made the notice public |
| `healthHazard` | the manufacturer's health hazard evaluation |
| `responseStatus` | `awaiting`, or `responded` once a response is on file with the exchange |
| `lotsHeld` | from the response on file: the lot numbers we quarantined |
| `dosesHeld` | from the response on file: the doses in those lots |
| `shipmentsInTransit` | from the response on file: the shipment references reported in transit |
| `signedOffBy` | from the response on file: the person who signed it off |

  The last four come from the exchange's response, so they reflect what the
  exchange holds, including a response filed before this application
  existed.

## What a response holds

When a response is signed off:

- Our affected lots are every lot the notice lists that is in the pharmacy
  inventory and not destroyed. Each is quarantined in the pharmacy
  inventory with a hold reason that contains the recall number. A lot the
  notice does not list stays as it is, even on the same shipment.
- The response filed with the exchange gives those lot numbers, the sum of
  their doses, the references of the shipments carrying one of them that
  the shipment tracker shows as in transit (a delivered or held shipment is
  not in transit, whatever the inventory says of the lot), and the display
  name of the quality assurance person who signed it off.
- The run is then `completed`.

A notice names a product by NDC. If any lot it lists is in our inventory
with a different NDC, the notice does not describe our stock and the
request fails.

## Who may do what

- Quality assurance reads every notice. A notice still under embargo is
  need-to-know for quality assurance alone: no one else reads it, finds it
  in a query, or may ask to respond to it.
- The health hazard evaluation is confidential: only quality assurance
  reads it. Everyone else who reads a notice reads it without that field.
- A logistics coordinator and the auditor read the public notices. A
  carrier's dispatcher reads no notice. Someone not signed in sees nothing
  and may do nothing.
- A logistics coordinator and quality assurance may ask to respond; the
  auditor and a carrier may not.
- Only quality assurance signs off, and never for a response they asked for
  themselves. No one else may approve, whoever asked.

## People

| Token | Who |
|---|---|
| `demo-logistics-token` | Dana Whitfield, logistics coordinator (the host's existing logistics identity) |
| `demo-qa-token` | Dr. Priya Raman, quality assurance (the host's existing QA identity, cleared CONFIDENTIAL) |
| `demo-qa2-token` | Dr. Tomasz Brandt, quality assurance: new; the same role and clearance as Dr. Raman, subject id `user-qa-2`, display name `Dr. Tomasz Brandt`. `resolveColdChainIdentity` does not know this token; the application must resolve it. |
| `demo-auditor-token` | Sam Ortega, auditor |
| `demo-carrier-token` | Northline dispatch, a carrier's dispatcher |
| none | someone not signed in |
