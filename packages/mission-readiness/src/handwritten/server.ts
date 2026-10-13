import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { AuthorizationError, InvalidInputError, NotFoundError, PreconditionFailedError, type Identity, type ResolvedObject } from "@typesys/core";
import { bearerToken, clientRouter, originGuard } from "@typesys/http";
import { MISSION_SIGN_INS, resolveMissionIdentity, type MissionBackend } from "../shared/backend.js";

/*
 * The same mission application written the way the baseline allowed
 * (docs/evidence/baseline-2026-10-13.md): the runtime called in process
 * with string names and untyped values, the app's own routes and error
 * mapping, a computed value filtered in the app, no Action previews, and
 * the ground-for-repair process written out by hand. Access rules the UI
 * needs before acting are restated here; each is marked ACCESS.
 */

interface Pending {
  id: string;
  initiator: Identity;
  tail: string;
  proposal: { eventId: string; priority: string; rationale: string };
}

const LOCAL = ["localhost", "127.0.0.1", "[::1]"];

export function createHandwrittenApp(backend: MissionBackend, clientDir: string): Express {
  const { runtime, triage } = backend;
  const pending = new Map<string, Pending>();
  const app = express();
  app.use(originGuard(LOCAL, undefined, (res, message) => res.status(403).json({ error: message })));
  app.use(express.json());

  const route = (handler: (req: Request, who: Identity) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const who = await resolveMissionIdentity(bearerToken(req) ?? null);
      res.json(await handler(req, who));
    } catch (err) {
      const status =
        err instanceof AuthorizationError ? 403 : err instanceof NotFoundError ? 404 : err instanceof InvalidInputError ? 400 : err instanceof PreconditionFailedError ? 409 : 500;
      res.status(status).json({ error: status === 500 ? "Internal error" : (err as Error).message });
    }
  };
  const name = (who: Identity) => (typeof who.attributes.displayName === "string" ? who.attributes.displayName : who.subjectId);
  const isMaintainer = (who: Identity) => who.roles.includes("maintainer"); // ACCESS: airforce.maintainer-only
  const isLead = (who: Identity) => who.roles.includes("maintainer") && who.roles.includes("lead"); // ACCESS: airforce.maintenance-lead
  const param = (req: Request, key: string) => String(req.params[key]);

  app.get("/app/me", route(async (_req, who) => ({ name: who.subjectId })));

  app.get(
    "/app/board",
    route(async (_req, who) => {
      // needsAttention is computed, and the baseline could not filter on a computed property (ADR-0054 added it): read every aircraft and filter here.
      const all: ResolvedObject[] = [];
      let cursor: string | undefined;
      do {
        const page = await runtime.query(
          { type: "airforce.Aircraft", select: ["tailNumber", "model", "readinessStatus", "deploymentLocation", "needsAttention"], sort: [{ property: "tailNumber" }], limit: 100, ...(cursor ? { cursor } : {}) },
          who
        );
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return all
        .filter((a) => a.values.needsAttention === true)
        .slice(0, 50)
        .map((a) => ({ id: a.objectId, tailNumber: a.values.tailNumber, model: a.values.model, readinessStatus: a.values.readinessStatus, deploymentLocation: a.values.deploymentLocation }));
    })
  );

  app.get(
    "/app/aircraft/:tail/events",
    route(async (req, who) => {
      const events = await runtime.query(
        {
          type: "airforce.MaintenanceEvent",
          filter: { property: "aircraftId", operator: "eq", value: param(req, "tail") },
          include: [{ relationship: "workOrder" }],
          sort: [{ property: "occurredAt", direction: "desc" }]
        },
        who
      );
      return events.items.map((e) => {
        const order = (e.values.workOrder as ResolvedObject[] | undefined)?.[0];
        return {
          id: e.objectId,
          eventType: e.values.eventType,
          occurredAt: e.values.occurredAt,
          description: e.values.description,
          canOpen: isMaintainer(who),
          workOrder: order && {
            id: order.objectId,
            status: order.values.status,
            assignedTo: order.values.assignedTo,
            canUpdate: isMaintainer(who) && (order.values.assignedTo === name(who) || who.roles.includes("lead")) // ACCESS: airforce.work-order-assignee
          }
        };
      });
    })
  );

  app.post(
    "/app/events/:id/work-orders",
    route(async (req, who) => runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: param(req, "id"), assignedTo: "SSgt Rivera" }, who))
  );

  app.post(
    "/app/work-orders/:id/status",
    route(async (req, who) => {
      const status = (req.body as { status?: unknown }).status;
      if (status !== "open" && status !== "in-progress" && status !== "closed") throw new InvalidInputError("status must be open, in-progress or closed");
      return runtime.invokeAction("UpdateWorkOrderStatus", { workOrderId: param(req, "id"), status }, who);
    })
  );

  app.post(
    "/app/aircraft/:tail/ground",
    route(async (req, who) => {
      if (!isMaintainer(who)) throw new AuthorizationError("Not authorized: ground for repair"); // ACCESS: the process's start rule
      const tail = param(req, "tail");
      const aircraft = await runtime.getObject("airforce.Aircraft", tail, who);
      if (aircraft.values.needsAttention !== true) return { status: "completed", reason: "The aircraft does not need attention" };
      const history = (await runtime.getRelationship("airforce.Aircraft", tail, "maintenance", who)).map((e) => ({
        id: e.objectId,
        eventType: e.values.eventType,
        occurredAt: e.values.occurredAt,
        description: e.values.description
      }));
      const answer = (await triage.complete({
        workflow: "ground-for-repair",
        step: "triage",
        prompt: "Choose the one maintenance event a work order should be opened for, its priority, and a one-sentence rationale.",
        input: { aircraft: { tailNumber: aircraft.values.tailNumber, model: aircraft.values.model, readinessStatus: aircraft.values.readinessStatus }, history },
        outputSchema: { type: "object" }
      })) as Pending["proposal"];
      if (typeof answer?.eventId !== "string" || !history.some((e) => e.id === answer.eventId)) throw new PreconditionFailedError("The triage named an event that is not in this aircraft's history");
      const id = randomUUID();
      pending.set(id, { id, initiator: who, tail, proposal: { eventId: answer.eventId, priority: String(answer.priority), rationale: String(answer.rationale) } });
      return { status: "waiting-approval" };
    })
  );

  app.get(
    "/app/approvals",
    route(async (_req, who) =>
      isLead(who) // ACCESS: who may see and approve
        ? [...pending.values()].filter((p) => p.initiator.subjectId !== who.subjectId).map((p) => ({ id: p.id, tailNumber: p.tail, proposal: p.proposal })) // ACCESS: no self-approval
        : []
    )
  );

  app.post(
    "/app/approvals/:id",
    route(async (req, who) => {
      const p = pending.get(param(req, "id"));
      if (!p) throw new NotFoundError("No such approval");
      if (!isLead(who) || p.initiator.subjectId === who.subjectId) throw new AuthorizationError("Not authorized: approve"); // ACCESS: lead, not the initiator
      pending.delete(p.id);
      // The work order is opened and started as the person who asked for it.
      const order = (await runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: p.proposal.eventId, assignedTo: "SSgt Rivera" }, p.initiator)) as { id: string };
      try {
        await runtime.invokeAction("UpdateWorkOrderStatus", { workOrderId: order.id, status: "in-progress" }, p.initiator);
      } catch (err) {
        await runtime.invokeAction("UpdateWorkOrderStatus", { workOrderId: order.id, status: "closed" }, p.initiator);
        throw err;
      }
      return { status: "completed" };
    })
  );

  app.use(clientRouter({ dir: clientDir, config: { signIns: MISSION_SIGN_INS } }));
  return app;
}
