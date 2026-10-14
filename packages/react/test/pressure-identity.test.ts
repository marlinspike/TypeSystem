import { describe, it, expect, beforeAll } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { buildAirforceTestbed, demoIdentities, type AirforceModel, type AirforceTestbed } from "@typesys/domain-airforce";
import { createClient, runtimeTransport } from "@typesys/sdk";
import { createTypeSysHooks, dataOf, type Loaded } from "../src/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { TypeSysProvider, useObject } = createTypeSysHooks<AirforceModel>();

let testbed: AirforceTestbed;
beforeAll(async () => {
  testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
});
const clientFor = (who: keyof typeof demoIdentities) => createClient<AirforceModel>(runtimeTransport(testbed.runtime, demoIdentities[who]));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await act(() => new Promise((r) => setTimeout(r, 2)));
}

describe("pressure: the hooks when the signed-in caller changes", () => {
  it("a caller who signs in after another never sees the previous caller's data, even when they are refused", async () => {
    let latest!: Loaded<unknown>;
    function Probe(): null {
      latest = useObject("airforce.Aircraft", "AF86-0147");
      return null;
    }
    const tree = (client: ReturnType<typeof clientFor>) => createElement(TypeSysProvider, { client }, createElement(Probe)) as ReactElement;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(tree(clientFor("maintainer")));
    });
    await until(() => latest.status === "success");
    expect(latest.status).toBe("success"); // the maintainer reads it

    // Same component tree, the provider now holds the anonymous caller's client (sign-out / switch user).
    await act(async () => {
      renderer.update(tree(clientFor("anonymous")));
    });
    await until(() => latest.status === "error" || latest.status === "success");
    expect(latest.status).toBe("error"); // anonymous is refused...
    expect(dataOf(latest)).toBeUndefined(); // ...and must not still be handed the maintainer's object
  });
});
