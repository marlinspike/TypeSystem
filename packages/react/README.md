# @typesys/react

Headless React bindings for TypeS
([ADR-0058](../../docs/adr/0058-governed-http-api-and-headless-react-bindings.md)):
hooks typed by a generated model over the governed SDK client, and form
fields and table columns derived from the model. No components and no
styling; every value and every refusal is the runtime's, for the client's
caller.

```ts
import { createTypeSHooks, formFields, columnsFor } from "@typesys/react";

const { TypeSProvider, useQuery, useObject, useActions, useAction } = createTypeSHooks<AirforceModel>();

const list = useQuery((c) => c.from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)), []);
const close = useAction("UpdateWorkOrderStatus");   // preview, then invoke
```

React 18 or 19. State lives in `Resource`, which has no React dependency.
See [`docs/how-to/build-an-app-with-the-api-and-react.md`](../../docs/how-to/build-an-app-with-the-api-and-react.md).
