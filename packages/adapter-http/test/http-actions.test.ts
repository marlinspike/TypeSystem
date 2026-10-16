import { describe, expect, it } from "vitest";
import { AdapterUnavailableError, SourceRefusedError, isRetryableError, type ActionContext, type ActionDefinition } from "@typesys/core";
import { HttpAdapter, type HttpAdapterConfig } from "../src/index.js";

/**
 * Actions over HTTP (ADR-0076): an onboarded service's command operation is
 * an Action's implementation. The path takes the target's id, the body only
 * the fields the mapping names, and a failure after the service answered
 * is never retried, since the request may already have had its effect.
 */
function stub(respond: (url: URL, init: RequestInit, n: number) => { status: number; body?: string }) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchStub = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    const { status, body } = respond(url, init, calls.length);
    return new Response(body ?? null, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchStub, calls };
}

const action = { name: "ChangeDutyStatus" } as ActionDefinition;
const ctx = {} as ActionContext;
const adapter = (fetchStub: typeof fetch, auth?: HttpAdapterConfig["auth"]) =>
  new HttpAdapter({
    dataSourceId: "roster",
    system: "Crew Roster",
    baseUrl: "http://roster.test",
    ...(auth ? { auth } : {}),
    types: {},
    actions: { ChangeDutyStatus: { method: "POST", path: "/api/members/{memberId}/duty", body: ["duty"] } },
    fetch: fetchStub
  });

describe("HTTP Actions", () => {
  it("puts the id in the path, encoded, and only the mapped fields in the body", async () => {
    const { fetchStub, calls } = stub(() => ({ status: 200, body: JSON.stringify({ id: "C/1", duty: "leave" }) }));
    const out = await adapter(fetchStub).executeAction(action, { memberId: "C/1", duty: "leave", note: "not sent" }, ctx);
    expect(out).toEqual({ id: "C/1", duty: "leave" });
    expect(calls[0]!.url.pathname).toBe("/api/members/C%2F1/duty");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ duty: "leave" });
  });

  it("refuses a path segment that would resolve to another endpoint, and a missing id", async () => {
    const { fetchStub, calls } = stub(() => ({ status: 200 }));
    await expect(adapter(fetchStub).executeAction(action, { memberId: "..", duty: "leave" }, ctx)).rejects.toThrow(/not a valid path segment/);
    await expect(adapter(fetchStub).executeAction(action, { duty: "leave" }, ctx)).rejects.toThrow(/needs "memberId"/);
    expect(calls).toHaveLength(0);
  });

  it("renews an expired token once; a refusal is the source's", async () => {
    let tokens = 0;
    const { fetchStub } = stub((url, init) => {
      if (url.pathname === "/token") return { status: 200, body: JSON.stringify({ access_token: `t${++tokens}`, expires_in: 3600 }) };
      const auth = new Headers(init.headers).get("authorization");
      return auth === "Bearer t2" ? { status: 403 } : { status: 401 };
    });
    const err = await adapter(fetchStub, { kind: "client-credentials", tokenUrl: "http://roster.test/token", clientId: "c", clientSecret: "s" })
      .executeAction(action, { memberId: "C-1", duty: "leave" }, ctx)
      .catch((e: unknown) => e);
    expect(tokens).toBe(2);
    expect(err).toBeInstanceOf(SourceRefusedError);
  });

  it("a server error or an unreadable answer is unavailable and not retryable; a client error is an error", async () => {
    for (const [status, body, kind] of [
      [503, undefined, AdapterUnavailableError],
      [200, "<html>", AdapterUnavailableError],
      [422, undefined, Error]
    ] as const) {
      const { fetchStub, calls } = stub(() => ({ status, ...(body ? { body } : {}) }));
      const err = await adapter(fetchStub).executeAction(action, { memberId: "C-1", duty: "x" }, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(kind);
      expect(isRetryableError(err)).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("an Action with no mapping is an error naming it", async () => {
    const { fetchStub } = stub(() => ({ status: 200 }));
    await expect(adapter(fetchStub).executeAction({ name: "Other" } as ActionDefinition, {}, ctx)).rejects.toThrow(/no request for Action Other/);
  });
});
