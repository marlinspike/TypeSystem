// coldchain.RespondToRecall: a coordinator or quality assurance asks to respond
// to a recall notice; quality assurance (never the person who asked) signs it
// off at `qaSignoff`; only then are our affected lots quarantined in the
// pharmacy inventory and the response filed with the recall exchange. Every
// read and write goes through the SemanticRuntime, as the person acting.
import { randomUUID } from "node:crypto";
import { AuthorizationError, NotFoundError, decideForIdentity } from "@typesys/core";
import { displayNameOf, isSignedIn } from "./host.mjs";
import { workflowIdentity } from "./recall-model.mjs";

export const WORKFLOW = "coldchain.RespondToRecall";
export const STEP = "qaSignoff";

/** A run's outcome for this caller: refused (403), unknown (404) or bad input (400). */
export class WorkflowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** An NDC as its eleven digits: the exchange's form. A hyphenated 10-digit NDC is padded in the segment HIPAA pads. */
export function ndc11(ndc) {
  if (typeof ndc !== "string") return undefined;
  const parts = ndc.trim().split("-");
  if (parts.length === 3) {
    const [a, b, c] = parts;
    const digits = `${a.padStart(5, "0")}${b.padStart(4, "0")}${c.padStart(2, "0")}`;
    return /^\d{11}$/.test(digits) ? digits : undefined;
  }
  const digits = ndc.replace(/\D/g, "");
  return digits.length === 11 ? digits : undefined;
}

/** The check that failed, said to the run's people. */
class CheckFailed extends Error {}

export class RecallWorkflow {
  /** @param {{ runtime: import("@typesys/core").SemanticRuntime, policyEngine: import("@typesys/core").PolicyEngine }} host */
  constructor(host) {
    this.runtime = host.runtime;
    this.policyEngine = host.policyEngine;
    this.runs = new Map();
    /** One sign-off at a time per notice, so two runs cannot both answer it. */
    this.locks = new Map();
  }

  async allowed(identity, policyName, resource) {
    if (!isSignedIn(identity)) return false;
    const d = await decideForIdentity(this.policyEngine, { subject: identity, action: "invoke", policyName, resource });
    return d.allow === true;
  }

  /**
   * What a response to `recallId` would hold, read as `actor`, or the check it fails.
   * The notice is read as the actor, so an embargoed notice refuses whoever may not read it.
   */
  async assess(recallId, actor) {
    let notice;
    try {
      notice = (await this.runtime.getObject("coldchain.Recall", recallId, actor)).values;
    } catch (err) {
      if (err instanceof AuthorizationError) throw err;
      if (err instanceof NotFoundError) throw new CheckFailed(`No recall notice ${recallId} on the exchange`);
      throw err;
    }
    if (notice.lifecycle === "terminated") throw new CheckFailed(`The manufacturer terminated recall ${recallId}`);
    if (notice.responseStatus !== "awaiting") throw new CheckFailed(`A response to recall ${recallId} is already on file with the exchange`);
    // The lots the notice lists: read by the workflow itself, since people read the notice without them.
    const listed = (await this.runtime.getObject("coldchain.Recall", recallId, workflowIdentity)).values.affectedLots;
    if (!Array.isArray(listed)) throw new Error(`Recall ${recallId} lists no lots`);
    const lots = [];
    for (const entry of listed) {
      const lotCode = typeof entry === "string" ? entry : entry?.lotCode;
      if (typeof lotCode !== "string" || lotCode === "") continue;
      let lot;
      try {
        lot = (await this.runtime.getObject("coldchain.Lot", lotCode, actor)).values;
      } catch (err) {
        // A lot the manufacturer made that we never held.
        if (err instanceof NotFoundError) continue;
        throw err;
      }
      if (ndc11(lot.ndc) !== notice.ndc) {
        throw new CheckFailed(`Lot ${lotCode} is ${lot.product ?? "another product"} (NDC ${lot.ndc}) in our inventory, not the product recall ${recallId} names (NDC ${notice.ndc})`);
      }
      if (lot.status === "destroyed") continue;
      lots.push({ lotId: lotCode, doses: Number.isInteger(lot.doses) ? lot.doses : 0, shipmentId: lot.shipmentId, status: lot.status, holdReason: lot.holdReason ?? null });
    }
    return { notice, lots };
  }

  async start(name, input, identity) {
    if (name !== WORKFLOW) throw new WorkflowError(404, `No workflow ${name}`);
    if (!(await this.allowed(identity, "coldchain.recall-respond", { typeName: "coldchain.Recall", actionName: WORKFLOW }))) {
      throw new WorkflowError(403, "Only a logistics coordinator or quality assurance may ask to respond to a recall");
    }
    const recallId = input?.recallId;
    if (typeof recallId !== "string" || recallId.trim() === "") throw new WorkflowError(400, "input.recallId (the exchange's recall number) is required");
    const run = {
      runId: randomUUID(),
      workflow: WORKFLOW,
      input: { recallId },
      status: "running",
      startedBy: { subjectId: identity.subjectId, displayName: displayNameOf(identity) },
      startedAt: new Date().toISOString(),
      approvals: []
    };
    try {
      const { notice, lots } = await this.assess(recallId, identity);
      run.status = "waiting-approval";
      run.waitingOn = { step: STEP };
      run.proposed = { product: notice.product, lots: lots.map((l) => l.lotId), doses: lots.reduce((n, l) => n + l.doses, 0) };
    } catch (err) {
      if (err instanceof AuthorizationError) throw new WorkflowError(403, "You may not respond to this recall notice");
      run.status = "failed";
      run.error = err instanceof CheckFailed ? err.message : `The response could not be prepared: ${err.message}`;
    }
    this.runs.set(run.runId, run);
    return run;
  }

  /** Whether `identity` may approve the step `run` waits on: quality assurance, never the person who asked. */
  async mayApprove(run, identity, step = run.waitingOn?.step) {
    if (step !== STEP) return false;
    if (identity.subjectId === run.startedBy.subjectId) return false;
    return this.allowed(identity, "coldchain.recall-signoff", { typeName: "coldchain.Recall", objectId: run.input.recallId, actionName: `${WORKFLOW}.${STEP}` });
  }

  async canSee(run, identity) {
    if (!isSignedIn(identity)) return false;
    if (identity.subjectId === run.startedBy.subjectId) return true;
    if (run.approvals.some((a) => a.subjectId === identity.subjectId)) return true;
    return run.status === "waiting-approval" && (await this.mayApprove(run, identity));
  }

  async get(runId, identity) {
    const run = this.runs.get(runId);
    if (!run || !(await this.canSee(run, identity))) throw new WorkflowError(404, "No such run");
    return run;
  }

  async approve(runId, step, body, identity) {
    const run = this.runs.get(runId);
    if (!run) throw new WorkflowError(404, "No such run");
    if (step !== STEP) {
      if (await this.canSee(run, identity)) throw new WorkflowError(404, `This workflow has no approval step ${step}`);
      throw new WorkflowError(404, "No such run");
    }
    if (!(await this.mayApprove(run, identity, step))) {
      throw new WorkflowError(403, identity.subjectId === run.startedBy.subjectId ? "You asked for this response: someone else in quality assurance must sign it off" : "Only quality assurance may sign off a recall response");
    }
    if (run.status !== "waiting-approval" || run.waitingOn?.step !== step) throw new WorkflowError(409, `The run is ${run.status}, not waiting on ${step}`);
    const approved = body?.approved;
    if (typeof approved !== "boolean") throw new WorkflowError(400, "approved (true or false) is required");
    const recallId = run.input.recallId;
    const previous = this.locks.get(recallId) ?? Promise.resolve();
    const turn = previous.then(() => this.signOff(run, approved, identity));
    this.locks.set(recallId, turn.catch(() => undefined));
    return turn;
  }

  async signOff(run, approved, identity) {
    // Decided while waiting for another sign-off on the same notice: look again.
    if (run.status !== "waiting-approval") throw new WorkflowError(409, `The run is ${run.status}`);
    const decision = { step: STEP, subjectId: identity.subjectId, displayName: displayNameOf(identity), approved, at: new Date().toISOString() };
    run.approvals.push(decision);
    delete run.waitingOn;
    if (!approved) {
      run.status = "failed";
      run.error = `${decision.displayName} did not sign the response off`;
      return run;
    }
    run.status = "running";
    const recallId = run.input.recallId;
    let assessed;
    try {
      // Checked again: the notice, or our inventory, may have changed since it was asked for.
      assessed = await this.assess(recallId, identity);
    } catch (err) {
      run.status = "failed";
      run.error = err instanceof CheckFailed ? err.message : `The response could not be prepared: ${err.message}`;
      return run;
    }
    const { notice, lots } = assessed;
    const reason = `Recall ${recallId}: ${notice.firm} ${notice.product}${notice.recallClass ? `, class ${notice.recallClass}` : ""}`;
    const held = [];
    try {
      for (const lot of lots) {
        if (lot.status === "quarantined" && typeof lot.holdReason === "string" && lot.holdReason.includes(recallId)) continue;
        if (lot.status === "quarantined") {
          // Already held for another reason: held again, under a reason naming this recall as well.
          await this.runtime.invokeAction("ReleaseLot", { lotId: lot.lotId }, identity);
          held.push({ ...lot, restore: lot.holdReason });
          await this.runtime.invokeAction("QuarantineLot", { lotId: lot.lotId, reason: `${lot.holdReason ? `${lot.holdReason}; ` : ""}${reason}` }, identity);
        } else {
          held.push(lot);
          await this.runtime.invokeAction("QuarantineLot", { lotId: lot.lotId, reason }, identity);
        }
      }
      const inTransit = [];
      for (const shipmentId of [...new Set(lots.map((l) => l.shipmentId).filter((s) => typeof s === "string" && s !== ""))]) {
        let shipment;
        try {
          shipment = (await this.runtime.getObject("coldchain.Shipment", shipmentId, identity)).values;
        } catch (err) {
          if (err instanceof NotFoundError) continue;
          throw err;
        }
        if (shipment.status === "in-transit") inTransit.push(shipmentId);
      }
      const response = {
        recallId,
        lotsQuarantined: lots.map((l) => l.lotId),
        dosesQuarantined: lots.reduce((n, l) => n + l.doses, 0),
        shipmentsInTransit: inTransit,
        signedOffBy: displayNameOf(identity)
      };
      await this.runtime.invokeAction("FileRecallResponse", response, identity);
      run.status = "completed";
      run.result = { lotsHeld: response.lotsQuarantined, dosesHeld: response.dosesQuarantined, shipmentsInTransit: inTransit, signedOffBy: response.signedOffBy };
      run.completedAt = new Date().toISOString();
    } catch (err) {
      // Nothing is held for a response that was not filed: undo the holds this sign-off made.
      await this.undo(held, identity);
      run.status = "failed";
      run.error = `The response could not be completed, and the lots it held were released: ${err.message}`;
    }
    return run;
  }

  async undo(held, identity) {
    for (const lot of held.reverse()) {
      try {
        await this.runtime.invokeAction("ReleaseLot", { lotId: lot.lotId }, identity);
        if (lot.restore !== undefined) await this.runtime.invokeAction("QuarantineLot", { lotId: lot.lotId, reason: lot.restore ?? "held" }, identity);
      } catch (err) {
        console.error(`could not undo the hold on ${lot.lotId}: ${err.message}`);
      }
    }
  }
}

/** A run as the API answers it. */
export function runView(run) {
  return {
    runId: run.runId,
    workflow: run.workflow,
    status: run.status,
    ...(run.waitingOn ? { waitingOn: run.waitingOn } : {}),
    input: run.input,
    startedBy: run.startedBy.displayName,
    ...(run.error ? { error: run.error } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(run.approvals.length ? { approvals: run.approvals.map(({ step, displayName, approved, at }) => ({ step, by: displayName, approved, at })) } : {})
  };
}
