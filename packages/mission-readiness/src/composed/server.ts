import type { Express } from "express";
import { clientRouter, createApiApp } from "@typesys/http";
import { MISSION_SIGN_INS, resolveMissionIdentity, type MissionBackend } from "../shared/backend.js";

/** The composed mission application: the governed API, its workflows, and the client. Nothing else. */
export function createComposedApp(backend: MissionBackend, clientDir: string): Express {
  const app = createApiApp({ backend, identityResolver: resolveMissionIdentity, workflows: backend.workflows });
  app.use(clientRouter({ dir: clientDir, config: { signIns: MISSION_SIGN_INS } }));
  return app;
}
