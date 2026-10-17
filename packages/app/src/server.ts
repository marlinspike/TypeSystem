import { existsSync, readFileSync } from "node:fs";
import type { Identity, PolicyEngine, SemanticRegistry, SemanticRuntime } from "@typesys/core";
import { clientRouter, createApiApp } from "@typesys/http";
import { createLlm, workflowModel, type LlmConfig, type LlmOptions } from "@typesys/llm";
import { WorkflowEngine, type AiModel, type AnyWorkflow, type WorkflowJournal } from "@typesys/workflow";
import type { Express } from "express";

/** What an application runs on: the governed runtime over its sources, as a host module builds it. */
export interface AppBackend {
  readonly runtime: SemanticRuntime;
  readonly registry: SemanticRegistry;
  readonly policyEngine: PolicyEngine;
}

export interface AppServerOptions {
  readonly backend: AppBackend;
  /** Bearer token to the caller, as the host resolves it. The application assumes no identity of its own. */
  readonly identities: (token: string | null | undefined) => Promise<Identity> | Identity;
  /** The compiled flows, registered with the engine as any workflow is. */
  readonly flows: readonly AnyWorkflow[];
  /** Model role → configured model id (`models` in the application, ADR-0074). */
  readonly models?: Readonly<Record<string, string>>;
  /** The LLM configuration and how to reach its custom providers. Required when `models` is not empty. */
  readonly llm?: { readonly config: LlmConfig; readonly options?: LlmOptions };
  /** The built client (`index.html`, `app.js`, `app.css`), served with deep links. */
  readonly clientDir?: string;
  /** Default: the engine's in-memory journal, which a restart loses. */
  readonly journal?: WorkflowJournal;
  readonly title?: string;
}

/**
 * Reads `typesys.llm.json`, or the file `TYPESYS_LLM_CONFIG` names, as
 * @typesys/llm's `loadLlmConfig` does: an operator points a built
 * application at other models without rebuilding it. A missing file is a
 * clear error rather than a model that silently does not exist.
 */
export function readLlmConfig(file: string): LlmConfig {
  const chosen = process.env.TYPESYS_LLM_CONFIG || file;
  if (!existsSync(chosen)) throw new Error(`The application's LLM configuration ${chosen} does not exist`);
  return JSON.parse(readFileSync(chosen, "utf8")) as LlmConfig;
}

/**
 * The models each role names, as the workflow engine asks them (ADR-0081):
 * each a configured runtime model, with its own audience and fallbacks, so
 * the engine releases an AI step's input for exactly the model it sends it to.
 */
export function roleModels(models: Readonly<Record<string, string>>, llm: AppServerOptions["llm"]): Record<string, AiModel> {
  const roles = Object.entries(models);
  if (roles.length === 0) return {};
  if (!llm) throw new Error(`The application names models (${roles.map(([r]) => r).join(", ")}) but has no LLM configuration`);
  const configured = createLlm(llm.config, llm.options);
  return Object.fromEntries(roles.map(([role, id]) => [role, workflowModel(configured, id) as AiModel]));
}

/**
 * The application's server: the governed REST API over the host, with its
 * flows registered on the one workflow engine, and its client served
 * beside it. It adds no decision of its own: every read, Action, start and
 * approval is the runtime's or the engine's, as for any TypeSystem client.
 */
export async function createAppServer(opts: AppServerOptions): Promise<{ app: Express; workflows: WorkflowEngine }> {
  const workflows = await WorkflowEngine.create({
    host: opts.backend,
    models: roleModels(opts.models ?? {}, opts.llm),
    ...(opts.journal ? { journal: opts.journal } : {})
  });
  for (const flow of opts.flows) workflows.register(flow);
  const app = createApiApp({
    backend: opts.backend,
    identityResolver: async (token) => opts.identities(token),
    workflows,
    ...(opts.title ? { info: { title: opts.title } } : {})
  });
  if (opts.clientDir && existsSync(opts.clientDir)) app.use(clientRouter({ dir: opts.clientDir, spa: true }));
  return { app, workflows };
}
