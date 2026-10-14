/**
 * The squadron readiness application, both ways (ADR-0063):
 * `npm run build && npm run mission`, then open the composed version on
 * http://localhost:4500 and the hand-written one on http://localhost:4501.
 * Each runs on its own copy of the same fleet, and offers the demo's
 * maintainer, lead and viewer sign-ins (ADR-0050: a demonstration only).
 */
import path from "node:path";
import { MISSION_CLIENT_DIR, buildMissionBackend, createComposedApp, createHandwrittenApp } from "@typesys/mission-readiness";

const port = Number(process.env.PORT ?? 4500);
const composed = createComposedApp(await buildMissionBackend(), path.join(MISSION_CLIENT_DIR, "composed"));
const handwritten = createHandwrittenApp(await buildMissionBackend(), path.join(MISSION_CLIENT_DIR, "handwritten"));
composed.listen(port, "127.0.0.1", () => console.log(`Composed from TypeSys on http://localhost:${port}`));
handwritten.listen(port + 1, "127.0.0.1", () => console.log(`Written by hand on    http://localhost:${port + 1}`));
