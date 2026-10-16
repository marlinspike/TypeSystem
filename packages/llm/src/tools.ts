import { withAudience, type Identity, type JsonSchema2020, type ModelDescription, type QueryFilter, type QueryResult, type ResolvedObject, type SemanticQuery } from "@typesys/core";
import { LlmError } from "./errors.js";
import type { LanguageModel } from "./model.js";
import { OutputValidator } from "./structured.js";
import type { CallOptions, GenerateRequest, GenerateResult, Message, ToolCall, ToolSpec, Usage } from "./types.js";

/** A tool a model may call, and the code that runs it. */
export interface ExecutableTool extends ToolSpec {
  /** Receives the model's arguments only after they validate against `inputSchema`. */
  execute(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface ToolRun {
  /** The model's final answer, after its last tool round. */
  readonly result: GenerateResult;
  readonly messages: readonly Message[];
  readonly calls: readonly { readonly call: ToolCall; readonly ok: boolean; readonly error?: string }[];
  readonly usage: Usage;
  readonly rounds: number;
}

const validator = new OutputValidator();

/**
 * A bounded tool loop (ADR-0074), not an agent framework: call the model,
 * run the tools it asks for, send back the results, until it answers without
 * a tool call or `maxRounds` is reached. Every set of generated arguments is
 * validated against its tool's schema before the tool runs; an invalid set
 * goes back to the model as an error, and an unknown tool is never run.
 */
export async function runTools(model: LanguageModel, request: GenerateRequest, tools: readonly ExecutableTool[], options: CallOptions & { readonly maxRounds?: number } = {}): Promise<ToolRun> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const max = options.maxRounds ?? 8;
  let messages: Message[] = [...request.messages];
  const calls: ToolRun["calls"][number][] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for (let round = 1; ; round++) {
    const result = await model.generate({ ...request, messages, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }, options);
    usage = { inputTokens: usage.inputTokens + result.usage.inputTokens, outputTokens: usage.outputTokens + result.usage.outputTokens };
    if (result.toolCalls.length === 0) return { result, messages, calls, usage, rounds: round };
    if (round >= max) throw new LlmError("invalid-output", `Model ${model.id} was still calling tools after ${max} rounds`, { model: model.id, retryable: false });
    messages = [...messages, result.message];
    for (const call of result.toolCalls) {
      const tool = byName.get(call.name);
      let content: string;
      let ok = false;
      let error: string | undefined;
      if (!tool) error = `There is no tool "${call.name}"`;
      else {
        const problems = validator.problems(tool.inputSchema, call.input);
        if (problems.length > 0) error = `Invalid arguments: ${problems.join("; ")}`;
        else {
          try {
            content = JSON.stringify((await tool.execute(call.input, options.signal)) ?? null);
            ok = true;
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
        }
      }
      content = ok ? content! : JSON.stringify({ error });
      calls.push({ call, ok, ...(error ? { error } : {}) });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content, ...(ok ? {} : { isError: true }) });
    }
  }
}

/** The part of the runtime a model's tools read through. */
export interface GovernedReader {
  getObject(typeName: string, objectId: string, identity: Identity): Promise<ResolvedObject>;
  query(query: SemanticQuery, identity: Identity): Promise<QueryResult<ResolvedObject>>;
  describeModel(identity: Identity): Promise<ModelDescription>;
}

const str = { type: "string", minLength: 1 } as const;

/**
 * Read tools over the governed runtime for a model (ADR-0075): every read
 * runs as the person *and* the model's audience, so what a tool returns to
 * the model is what both may read, decided by the runtime's policies,
 * classification and plans, and audited with the audience. The model's
 * generated arguments are only a request: a type or id it invents is
 * refused like anyone's. No tool here acts; an application that wants a
 * model to invoke an Action gives it one explicitly, and the runtime
 * releases the Action's result to the audience only as far as the audience
 * may read it (ADR-0075).
 */
export function governedReadTools(runtime: GovernedReader, person: Identity, model: LanguageModel): ExecutableTool[] {
  const as = withAudience(person, model.info.audience);
  const masked = (err: unknown) => {
    // A refusal says only that: never which rule, nor whether the object exists.
    const name = (err as Error)?.name ?? "";
    if (/Authorization|NotFound|Classification/.test(name)) throw new Error("Not available");
    throw err;
  };
  return [
    {
      name: "typesys_describe",
      description: "The Types, relationships and Actions you may use, as the runtime describes them to you.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as JsonSchema2020,
      execute: async () => {
        const d = await runtime.describeModel(as);
        return { types: d.types.map((t) => ({ name: t.name, description: t.description, properties: Object.keys(t.properties), computed: t.computed.map((c) => c.name), relationships: t.relationships.map((r) => ({ name: r.name, target: r.target })) })) };
      }
    },
    {
      name: "typesys_get_object",
      description: "One object by Type and id, with the values you may read.",
      inputSchema: { type: "object", properties: { type: str, id: str }, required: ["type", "id"], additionalProperties: false } as JsonSchema2020,
      execute: async (input) => {
        const { type, id } = input as { type: string; id: string };
        try {
          const o = await runtime.getObject(type, id, as);
          return { type: o.typeName, id: o.objectId, values: o.values };
        } catch (err) {
          return masked(err);
        }
      }
    },
    {
      name: "typesys_query",
      description: "Objects of one Type matching a filter of equalities, at most 50.",
      inputSchema: {
        type: "object",
        properties: { type: str, where: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } }, limit: { type: "integer", minimum: 1, maximum: 50 } },
        required: ["type"],
        additionalProperties: false
      } as JsonSchema2020,
      execute: async (input) => {
        const { type, where, limit } = input as { type: string; where?: Record<string, string | number | boolean>; limit?: number };
        const filters: QueryFilter[] = Object.entries(where ?? {}).map(([property, value]) => ({ property, operator: "eq" as const, value }));
        try {
          const filter: QueryFilter | undefined = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : { and: filters };
          const r = await runtime.query({ type, ...(filter ? { filter } : {}), limit: limit ?? 20 }, as);
          return { items: r.items.map((o) => ({ id: o.objectId, values: o.values })) };
        } catch (err) {
          return masked(err);
        }
      }
    }
  ];
}
