/**
 * What a change to the model does, before it ships (ADR-0093):
 *
 *   npm run build && npm run impact:demo
 *
 * Records a baseline of the Air Force workbench as the lead, with how the
 * maintainer, the viewer and someone not signed in are decided on a read of
 * each Type, then builds the proposal that releases readinessStatus to every
 * reader, records it the same way, and compares the two against the
 * squadron application and the GroundForRepair workflow.
 */
import { describeModel } from "@typesys/core";
import { analyzeChange, recordBaseline, renderImpact } from "@typesys/devkit";
import { buildAirforceProposal, buildAirforceWorkbench, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { workflowUses } from "@typesys/workflow";
import { appUses } from "../packages/compiler/src/uses.js";
import { squadronApp } from "../packages/compiler/test/fixtures.js";

const callers = { maintainer: demoIdentities.maintainer, viewer: demoIdentities.viewer, anonymous: demoIdentities.anonymous };
const current = await buildAirforceWorkbench({ mockRestLatencyMs: 0 });
const before = await recordBaseline(current.runtime, demoIdentities.lead, { callers });
const proposal = await buildAirforceProposal({ mockRestLatencyMs: 0 });
const after = await recordBaseline(proposal.runtime, demoIdentities.lead, { callers });
const consumers = [...appUses(squadronApp(), await describeModel(proposal.registry)), workflowUses(groundForRepair)];
const impact = analyzeChange(before, after, consumers);
console.log("Proposal: release readinessStatus to every reader of an Aircraft, as needsAttention is.\n");
console.log(renderImpact(impact).join("\n"));
process.exitCode = impact.exposures.length > 0 ? 1 : 0;
