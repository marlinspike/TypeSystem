import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request a fake provider received. */
export interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

/** What a handler answers: JSON with a status, a stream of server-sent events, or a stream cut off part way. */
export type FakeReply =
  | { readonly status?: number; readonly json: unknown; readonly headers?: Record<string, string>; readonly delayMs?: number }
  | { readonly sse: readonly (Record<string, unknown> | "[DONE]")[]; readonly named?: boolean; readonly cutAfter?: number; readonly delayMs?: number };

/**
 * A provider on loopback that speaks the wire format the vendor SDKs speak
 * (JSON and server-sent events), so the adapters run through the real SDKs
 * against answers a test controls: malformed ones, rate limits, outages and
 * interrupted streams included.
 */
export async function fakeProvider(handler: (r: Received, n: number) => FakeReply | Promise<FakeReply>): Promise<{ url: string; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown>;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { $raw: text };
    }
    const r: Received = { method: req.method ?? "GET", path: (req.url ?? "/").split("?")[0]!, headers: req.headers, body };
    received.push(r);
    const reply = await handler(r, received.length);
    if (reply.delayMs) await new Promise((ok) => setTimeout(ok, reply.delayMs));
    if (res.destroyed) return;
    if ("json" in reply) {
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers ?? {}) });
      res.end(JSON.stringify(reply.json));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const events = reply.cutAfter !== undefined ? reply.sse.slice(0, reply.cutAfter) : reply.sse;
    for (const e of events) {
      if (e === "[DONE]") res.write("data: [DONE]\n\n");
      else res.write(`${reply.named ? `event: ${String(e.type)}\n` : ""}data: ${JSON.stringify(e)}\n\n`);
    }
    if (reply.cutAfter !== undefined) {
      // Let what was written reach the client before the connection drops.
      await new Promise((ok) => setTimeout(ok, 50));
      res.destroy();
    } else res.end();
  };
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      })
  };
}

/** An Anthropic Messages answer. */
export function anthropicMessage(content: readonly Record<string, unknown>[], stop = "end_turn", usage = { input_tokens: 12, output_tokens: 7 }): Record<string, unknown> {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content, stop_reason: stop, stop_sequence: null, usage };
}

/** The server-sent events of an Anthropic Messages stream of `text`, then a stop. */
export function anthropicStream(text: readonly string[], stop = "end_turn"): Record<string, unknown>[] {
  return [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...text.map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: "message_stop" }
  ];
}

/** A Chat Completions answer. */
export function chatCompletion(message: Record<string, unknown>, finish = "stop", usage: Record<string, unknown> | null = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }): Record<string, unknown> {
  return { id: "chatcmpl-1", object: "chat.completion", created: 1, model: "served-model", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

/** The chunks of a Chat Completions stream of `text`, then a finish and a usage chunk. */
export function chatStream(text: readonly string[], finish = "stop"): (Record<string, unknown> | "[DONE]")[] {
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta, finish_reason }] });
  return [
    chunk({ role: "assistant", content: "" }),
    ...text.map((t) => chunk({ content: t })),
    chunk({}, finish),
    { id: "c", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } },
    "[DONE]"
  ];
}
