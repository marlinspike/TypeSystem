import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A SIMULATED model: an OpenAI-compatible Chat Completions endpoint on
 * loopback that answers the Cold Chain stability assessment with a fixed
 * rule, the same rule as the application's in-process stand-in. It exists
 * so `TYPESYS_LLM_CONFIG=examples/apps/cold-chain/llm/simulated.json` runs
 * the real provider path (configuration, discovery, the OpenAI SDK over
 * HTTP, structured output, release to the model's audience) with no
 * account, no network and no cost. Every answer says it is simulated.
 */
export interface SimulatedModel {
  readonly url: string;
  /** The requests it has answered, newest last: what the model was sent, for the guide to show. */
  readonly received: { readonly at: string; readonly model: string; readonly messages: unknown }[];
  close(): Promise<void>;
}

export const SIMULATED_MODEL_ID = "stability-simulated";

/** The stability rule, over what the request says. */
export function assess(text: string): { disposition: "release" | "quarantine" | "destroy"; confidence: "low" | "medium" | "high"; rationale: string } {
  const num = (name: string) => Number(new RegExp(`\\\\?"${name}\\\\?":(-?[0-9.]+)`).exec(text)?.[1]);
  const peak = num("peakC");
  const minutes = num("minutesOut");
  const budget = num("budgetMinutes");
  const tag = " (simulated model)";
  if (!(Number.isFinite(peak) && Number.isFinite(minutes) && Number.isFinite(budget))) {
    return { disposition: "quarantine", confidence: "low", rationale: `The excursion's figures were not all available, so the lots are held until a pharmacist reviews them.${tag}` };
  }
  if (peak < 0) return { disposition: "destroy", confidence: "high", rationale: `The logger read ${peak} °C: the product froze.${tag}` };
  if (minutes >= budget) return { disposition: "quarantine", confidence: "medium", rationale: `${minutes} minutes outside 2–8 °C at a peak of ${peak} °C spends the ${budget}-minute stability budget.${tag}` };
  return { disposition: "release", confidence: "high", rationale: `${minutes} minutes at a peak of ${peak} °C is within the ${budget}-minute stability budget.${tag}` };
}

export async function startSimulatedModel(port = 0): Promise<SimulatedModel> {
  const received: SimulatedModel["received"][number][] = [];
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "x-typesys-simulated": "true" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && url === "/v1/models") return send(res, 200, { object: "list", data: [{ id: SIMULATED_MODEL_ID, object: "model", owned_by: "typesys-showcase-simulated" }] });
      if (req.method !== "POST" || url !== "/v1/chat/completions") return send(res, 404, { error: { message: "not found" } });
      let body: { model?: string; messages?: unknown; stream?: boolean };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        return send(res, 400, { error: { message: "not JSON" } });
      }
      if (body.stream) return send(res, 400, { error: { message: "the simulated model does not stream" } });
      received.push({ at: new Date().toISOString(), model: String(body.model), messages: body.messages });
      if (received.length > 20) received.shift();
      const text = JSON.stringify(body.messages ?? []);
      const content = JSON.stringify(assess(text));
      send(res, 200, {
        id: `chatcmpl-simulated-${received.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: Math.ceil((text.length + content.length) / 4) }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const { port: bound } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${bound}/v1`, received, close: () => new Promise((r) => server.close(() => r())) };
}
