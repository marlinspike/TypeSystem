// coldchain.RespondToRecall: ask, check, have quality assurance sign off, then quarantine and file.
import { NotFoundError } from "@typesys/core";
import { defineWorkflow } from "@typesys/workflow";
import { WORKFLOW } from "./model.mjs";

/** An NDC as eleven digits: the exchange's form, from the inventory's hyphenated 10- or 11-digit forms. */
export function ndc11(ndc) {
  if (typeof ndc !== "string") return undefined;
  const parts = ndc.trim().split("-");
  if (parts.length === 3) {
    const [a, b, c] = parts;
    return a.padStart(5, "0") + b.padStart(4, "0") + c.padStart(2, "0");
  }
  return ndc.replace(/\D/g, "");
}

const isNotFound = (err) => err instanceof NotFoundError || err?.name === "NotFoundError" || err?.status === 404;
const unavailable = (row, what) => {
  if (Array.isArray(row?.$unavailable) && row.$unavailable.length > 0) throw new Error(`${what} could not be read completely: ${row.$unavailable.map((u) => u.message).join("; ")}`);
};

function assertAnswerable(notice, recallId) {
  if (!notice || notice.$id !== recallId) throw new Error(`Recall ${recallId} could not be read`);
  unavailable(notice, `Recall ${recallId}`);
  if (notice.lifecycle === "terminated") throw new Error(`Recall ${recallId} was terminated by the manufacturer: it cannot be answered`);
  if (notice.responseStatus !== "awaiting") throw new Error(`Recall ${recallId} has already been answered`);
  return true;
}

/** @param {{ displayNameOf: (subjectId: string) => string | undefined }} directory */
export function respondToRecall(directory) {
  return defineWorkflow({
    name: WORKFLOW,
    version: "1.0.0",
    description: "Respond to a manufacturer's recall notice: find our affected lots, have quality assurance sign off, then quarantine them and file the response with the exchange.",
    startPolicy: "coldchain.recall-respond",
    inputSchema: { type: "object", properties: { recallId: { type: "string", minLength: 1 } }, required: ["recallId"], additionalProperties: false },
    steps: [
      {
        kind: "read",
        name: "notice",
        reads: ["coldchain.Recall"],
        run: (client, ctx) => client.get("coldchain.Recall", ctx.input.recallId)
      },
      {
        kind: "compute",
        name: "answerable",
        description: "Not terminated, and not already answered.",
        needs: ["notice"],
        run: (ctx) => assertAnswerable(ctx.output("notice"), ctx.input.recallId)
      },
      {
        kind: "read",
        name: "stock",
        description: "The notice's lots that are in our inventory, and the tracker's status of each shipment carrying one.",
        needs: ["notice", "answerable"],
        reads: ["coldchain.Lot", "coldchain.Shipment"],
        run: async (client, ctx) => {
          const notice = ctx.output("notice");
          const lots = [];
          for (const lotId of notice.affectedLots ?? []) {
            let lot;
            try {
              lot = await client.get("coldchain.Lot", lotId);
            } catch (err) {
              if (isNotFound(err)) continue; // a lot the manufacturer made that we never held
              throw err;
            }
            unavailable(lot, `Lot ${lotId}`);
            lots.push({ lotId: lot.$id, ndc: lot.ndc ?? null, product: lot.product ?? null, doses: lot.doses ?? 0, status: lot.status ?? null, shipmentId: lot.shipmentId ?? null });
          }
          const shipments = {};
          for (const id of [...new Set(lots.filter((l) => l.status !== "destroyed" && l.shipmentId).map((l) => l.shipmentId))]) {
            try {
              const s = await client.get("coldchain.Shipment", id);
              unavailable(s, `Shipment ${id}`);
              shipments[id] = s.status ?? null;
            } catch (err) {
              if (!isNotFound(err)) throw err;
              shipments[id] = null; // the tracker has no such shipment: not in transit
            }
          }
          return { lots, shipments };
        }
      },
      {
        kind: "compute",
        name: "response",
        description: "Every listed lot we hold is the notice's product; the response is our non-destroyed lots, their doses, and their shipments in transit.",
        needs: ["notice", "stock"],
        run: (ctx) => {
          const notice = ctx.output("notice");
          const { lots, shipments } = ctx.output("stock");
          const wanted = ndc11(notice.ndc);
          const mismatched = lots.filter((l) => ndc11(l.ndc) !== wanted);
          if (mismatched.length > 0) {
            throw new Error(`Recall ${notice.$id} names ${mismatched.map((l) => l.lotId).join(", ")}, which our inventory holds under a different product (NDC ${mismatched.map((l) => l.ndc).join(", ")}, not ${notice.ndc}): the notice does not describe our stock`);
          }
          const affected = lots.filter((l) => l.status !== "destroyed");
          const lotsQuarantined = affected.map((l) => l.lotId);
          const dosesQuarantined = affected.reduce((sum, l) => sum + (Number.isInteger(l.doses) ? l.doses : 0), 0);
          const shipmentsInTransit = [...new Set(affected.map((l) => l.shipmentId).filter((id) => id && shipments[id] === "in-transit"))];
          return { recallId: notice.$id, product: notice.product, ndc: notice.ndc, lotsQuarantined, dosesQuarantined, shipmentsInTransit };
        }
      },
      {
        kind: "approval",
        name: "qaSignoff",
        description: "Quality assurance signs the response off; never the person who asked for it.",
        needs: ["notice", "response"],
        policy: "coldchain.recall-signoff",
        present: (ctx) => ({ notice: ctx.output("notice"), response: ctx.output("response") })
      },
      {
        kind: "compute",
        name: "signer",
        description: "The display name of the quality assurance person who signed it off.",
        needs: ["qaSignoff"],
        run: (ctx) => {
          const approver = ctx.output("qaSignoff")?.approver;
          const name = typeof approver === "string" ? directory.displayNameOf(approver) : undefined;
          if (!name) throw new Error("The person who signed the response off has no display name");
          return name;
        }
      },
      {
        kind: "read",
        name: "current",
        description: "The notice again, as it is at sign-off: still active, still unanswered.",
        needs: ["qaSignoff"],
        reads: ["coldchain.Recall"],
        run: async (client, ctx) => {
          const notice = await client.get("coldchain.Recall", ctx.input.recallId);
          assertAnswerable(notice, ctx.input.recallId);
          return { recallId: notice.$id, lifecycle: notice.lifecycle, responseStatus: notice.responseStatus };
        }
      },
      {
        kind: "action",
        name: "quarantine",
        needs: ["current", "response", "signer"],
        action: "QuarantineRecallLots",
        input: (ctx) => {
          const r = ctx.output("response");
          return { recallId: ctx.input.recallId, lotIds: r.lotsQuarantined, reason: `Recall ${ctx.input.recallId}: ${r.product} (NDC ${r.ndc}), signed off by ${ctx.output("signer")}` };
        },
        compensate: {
          action: "ReleaseRecallLots",
          input: (ctx, output) => ({ recallId: ctx.input.recallId, lots: output?.lots ?? [] })
        }
      },
      {
        kind: "action",
        name: "file",
        needs: ["quarantine", "response", "signer"],
        action: "FileRecallResponse",
        input: (ctx) => {
          const r = ctx.output("response");
          return { recallId: ctx.input.recallId, lotsQuarantined: r.lotsQuarantined, dosesQuarantined: r.dosesQuarantined, shipmentsInTransit: r.shipmentsInTransit, signedOffBy: ctx.output("signer") };
        }
      }
    ]
  });
}
