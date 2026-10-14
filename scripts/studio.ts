/**
 * TypeSys Studio over the airforce demo (ADR-0061): `npm run build && npm run studio`,
 * then open http://localhost:4400. The header offers the demo's maintainer and
 * viewer tokens and anonymous access, so the same screens can be compared as
 * each. Demo tokens are for a demonstration only (ADR-0050).
 *
 * `TYPESYS_DISCOVERY=need-to-know npm run studio` shows each caller only the
 * part of the model they could use, and anonymous access nothing (ADR-0068).
 */
import type { Discovery } from "@typesys/core";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createStudioApp } from "@typesys/studio";

const discovery = (process.env.TYPESYS_DISCOVERY ?? "open") as Discovery;
const testbed = await buildAirforceTestbed({ runtimeOptions: { discovery } });
const app = createStudioApp({
  backend: testbed,
  identityResolver: resolveDemoIdentity,
  title: "TypeSys Studio · airforce demo",
  demoTokens: { Maintainer: "demo-maintainer-token", Viewer: "demo-viewer-token" }
});
const port = Number(process.env.PORT ?? 4400);
app.listen(port, "127.0.0.1", () => console.log(`TypeSys Studio on http://localhost:${port}`));
