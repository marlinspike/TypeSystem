/**
 * TypeS Studio over the airforce demo (ADR-0061): `npm run build && npm run studio`,
 * then open http://localhost:4400. The header offers the demo's maintainer and
 * viewer tokens and anonymous access, so the same screens can be compared as
 * each. Demo tokens are for a demonstration only (ADR-0050).
 */
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createStudioApp } from "@typesys/studio";

const testbed = await buildAirforceTestbed();
const app = createStudioApp({
  backend: testbed,
  identityResolver: resolveDemoIdentity,
  title: "TypeS Studio · airforce demo",
  demoTokens: { Maintainer: "demo-maintainer-token", Viewer: "demo-viewer-token" }
});
const port = Number(process.env.PORT ?? 4400);
app.listen(port, "127.0.0.1", () => console.log(`TypeS Studio on http://localhost:${port}`));
