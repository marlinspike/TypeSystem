import type { AggregateOp, JsonSchema2020 } from "@typesys/core";
import type { AcceptanceCheck, MissionCaller, MissionHost } from "@typesys/engineer";

/**
 * The semantic application IR (`typesys.app/1`, ADR-0079): what an
 * application means and does, independent of the code that implements it.
 * It is data, so an agent writes it, a person reviews it, and the checker,
 * the compiler and the verifier all read the same thing.
 *
 * It has five primitives and nothing else:
 *
 * - **read**: one governed read (an object, a query, a relationship, an
 *   aggregate), in the runtime's own query language.
 * - **expression**: a small, total, typed expression over references.
 * - **step**: one unit of a governed workflow (read, compute, check, ai,
 *   approval, action), composed by `when`, `parallel` and `forEach`.
 * - **node**: one piece of user interface (a layout, or a semantic
 *   component bound to reads, state and effects).
 * - **effect**: what an interaction does (set state, run a flow, invoke an
 *   Action, navigate, refresh).
 *
 * Anything these cannot say is said in TypeScript: an expression may call a
 * typed function (`fn`), and a node may be a typed React component
 * (`custom`), each in the application's own `src/extensions/`.
 */
export const APP_FORMAT = "typesys.app/1";

/**
 * A value position. A string starting with `$` is a reference
 * (`$scope.path`); `{ "literal": … }` is any JSON value, including a string
 * that starts with `$`; an object with one operator key is an operation.
 */
export type Expr =
  | string
  | number
  | boolean
  | null
  | { readonly literal: unknown }
  | { readonly [op in ExprOp]?: unknown }
  | FnCall;

/** A call of a handwritten, typed function in `src/extensions/<module>.ts`. */
export interface FnCall {
  /** `<module>#<export>`, the module relative to `src/extensions/`. */
  readonly fn: string;
  readonly args: Readonly<Record<string, Expr>>;
  /** What it returns, as JSON Schema: the generated contract the function must satisfy. */
  readonly returns: JsonSchema2020;
}

/**
 * The operators of an expression. Comparison is three-valued (Kleene): a
 * value the runtime withheld, or a step that was skipped, is *unknown*, and
 * a condition on an unknown value is not true. Nothing coerces: comparing a
 * string to a number is a compile error, not `false`.
 */
export const EXPR_OPS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "and",
  "or",
  "not",
  "exists",
  "if",
  "coalesce",
  "add",
  "sub",
  "mul",
  "div",
  "round",
  "concat",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "where",
  "pluck",
  "hoursSince"
] as const;
export type ExprOp = (typeof EXPR_OPS)[number];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A filter in the runtime's query language (ADR-0011), whose values may be expressions. */
export type FilterIR =
  | { readonly property: string; readonly operator: "eq" | "ne" | "in" | "gt" | "gte" | "lt" | "lte" | "icontains" | "contains"; readonly value: Expr }
  | { readonly and: readonly FilterIR[] }
  | { readonly or: readonly FilterIR[] };

export interface IncludeIR {
  readonly relationship: string;
  readonly filter?: FilterIR;
  readonly sort?: readonly { readonly property: string; readonly direction?: "asc" | "desc" }[];
  readonly limit?: number;
  readonly select?: readonly string[];
  readonly include?: readonly IncludeIR[];
}

/** A `SemanticQuery` (ADR-0027) with expressions in value positions: the same language every client already speaks. */
export interface QueryIR {
  readonly type: string;
  readonly filter?: FilterIR;
  readonly search?: { readonly text: Expr; readonly properties?: readonly string[] };
  readonly sort?: readonly { readonly property: string; readonly direction?: "asc" | "desc" }[];
  readonly select?: readonly string[];
  readonly include?: readonly IncludeIR[];
  readonly limit?: number;
  /** Read every page up to `limit` instead of the first. Default false. */
  readonly all?: boolean;
}

export interface AggregateIR {
  readonly type: string;
  readonly filter?: FilterIR;
  readonly groupBy?: readonly string[];
  readonly aggregations: readonly { readonly name: string; readonly op: AggregateOp; readonly property?: string }[];
}

/**
 * One governed read. Every kind goes through the runtime as the signed-in
 * caller (or, in a flow, as the run's initiator), so what it returns is what
 * policy and classification release.
 */
export type ReadIR =
  /** A list of objects. */
  | { readonly kind: "query"; readonly query: QueryIR }
  /** One object; nothing while `id` is unknown. */
  | { readonly kind: "object"; readonly type: string; readonly id: Expr; readonly provenance?: boolean }
  /** The objects one object's relationship reaches (ADR-0072: an optional relationship whose source fails says so). */
  | { readonly kind: "related"; readonly of: Expr; readonly type: string; readonly relationship: string }
  /** Grouped counts and sums, decided by the runtime (ADR-0027). */
  | { readonly kind: "aggregate"; readonly aggregate: AggregateIR };

/**
 * Application data: a read, or a value derived from other data on the
 * client. It refreshes when anything it references changes, after any
 * Action or run that can change a Type it reads, and every `everyMs` when
 * set.
 */
export type DataIR = (ReadIR | { readonly kind: "derive"; readonly value: Expr }) & { readonly description?: string; readonly refresh?: { readonly everyMs?: number } };

/** A value an application holds for the person using it: a selection, a filter, a form's draft. */
export interface StateIR {
  readonly schema: JsonSchema2020;
  readonly default?: unknown;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/** What every step may declare. */
export interface StepBaseIR {
  /** camelCase, unique in the flow; later steps refer to its output as `$<name>`. */
  readonly name: string;
  readonly description?: string;
  /** Runs only when true; otherwise skipped, and its output is unknown to every later step. */
  readonly when?: Expr;
  /** Retried only on an error that says it may succeed again (a timeout, an unreachable source). */
  readonly retry?: { readonly maxAttempts: number; readonly backoffMs?: number };
}

export type StepIR =
  | (StepBaseIR & { readonly kind: "read"; readonly read: ReadIR; readonly timeoutMs?: number; readonly onError?: "fail" | "continue" })
  | (StepBaseIR & { readonly kind: "compute"; readonly value: Expr })
  | (StepBaseIR & { readonly kind: "check"; readonly assert: Expr; readonly message: string })
  | (StepBaseIR & {
      readonly kind: "ai";
      /** A role in the application's `models`. */
      readonly model: string;
      readonly prompt: string;
      readonly input: Readonly<Record<string, Expr>>;
      readonly output: JsonSchema2020;
      /** When the model may not receive everything the person could send it (ADR-0067). Default `refuse`. */
      readonly release?: "refuse" | "redact";
    })
  | (StepBaseIR & {
      readonly kind: "approval";
      readonly policy: string;
      /** Earlier steps whose outputs the approver is shown, each as they may read it. */
      readonly present: readonly string[];
      readonly allowSelfApproval?: boolean;
      readonly deadlineMs?: number;
    })
  | (StepBaseIR & {
      readonly kind: "action";
      readonly action: string;
      readonly input: Readonly<Record<string, Expr>>;
      /** Run, in reverse order, when a later step fails or an approval is rejected. `$output` is this Action's output. */
      readonly compensate?: { readonly action: string; readonly input: Readonly<Record<string, Expr>> };
    })
  /** Reads that do not depend on each other, run at once; each is referred to by its own name. */
  | (StepBaseIR & { readonly kind: "parallel"; readonly steps: readonly (StepBaseIR & { readonly kind: "read"; readonly read: ReadIR; readonly timeoutMs?: number; readonly onError?: "fail" | "continue" })[] })
  /** One read per element of a list (`$item`), at most `max` elements: a longer list fails the step rather than being cut short. */
  | (StepBaseIR & { readonly kind: "forEach"; readonly over: Expr; readonly max: number; readonly read: ReadIR; readonly concurrency?: number });

export type StepKind = StepIR["kind"];

/** A flow's input field. */
export interface FlowInputIR {
  readonly schema: JsonSchema2020;
  /** The Type whose object id this input carries, for pickers and for the checker. */
  readonly objectOf?: string;
  readonly description?: string;
}

/** A governed workflow (ADR-0057), compiled to `defineWorkflow` and run by the existing engine. */
export interface FlowIR {
  /** Qualified like a Type (`coldchain.DispositionLot`): the resource every policy decision about it names. */
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description?: string;
  readonly startPolicy: string;
  readonly cancelPolicy?: string;
  readonly input: Readonly<Record<string, FlowInputIR>>;
  readonly steps: readonly StepIR[];
}

/** A model an AI step asks, by the id it has in the application's LLM configuration (ADR-0074). */
export interface ModelRoleIR {
  /** A model id in `typesys.llm.json`, configured for runtime use. */
  readonly id: string;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// User interface
// ---------------------------------------------------------------------------

/** What an interaction does. Effects in a list run in order; one that fails stops the rest. */
export type EffectIR =
  | { readonly set: string; readonly value: Expr }
  | { readonly run: string; readonly input: Readonly<Record<string, Expr>>; readonly into?: string }
  | { readonly invoke: string; readonly input: Readonly<Record<string, Expr>>; readonly confirm?: boolean }
  | { readonly navigate: string; readonly params?: Readonly<Record<string, Expr>> }
  | { readonly refresh: readonly string[] };

/** What every node may declare. */
export interface NodeBaseIR {
  /** Stable across compiles: what a screen check, a test or an extension names. */
  readonly id?: string;
  readonly title?: string;
  /** Columns of the parent grid this node spans (1 to 12). */
  readonly span?: number;
  /** Shown only when true. Never a security boundary: the runtime decides what the data holds. */
  readonly when?: Expr;
}

/** A column of a table, or a field of a detail. */
export type FieldRefIR =
  | string
  | { readonly field: string; readonly label?: string; readonly format?: ValueFormat; readonly tone?: Readonly<Record<string, Tone>> };

export type ValueFormat = "text" | "number" | "integer" | "percent" | "currency" | "date" | "date-time" | "relative-time" | "duration-minutes" | "badge" | "boolean" | "temperature";
export type Tone = "neutral" | "info" | "good" | "warn" | "bad";

export type NodeIR = NodeBaseIR &
  (
    | { readonly kind: "grid"; readonly columns?: number; readonly children: readonly NodeIR[] }
    | { readonly kind: "stack"; readonly direction?: "row" | "column"; readonly children: readonly NodeIR[] }
    | { readonly kind: "tabs"; readonly tabs: readonly { readonly label: string; readonly content: NodeIR }[] }
    | { readonly kind: "section"; readonly children: readonly NodeIR[]; readonly description?: string }
    | { readonly kind: "text"; readonly text: Expr; readonly tone?: Tone }
    | { readonly kind: "metric"; readonly label: string; readonly value: Expr; readonly format?: ValueFormat; readonly tone?: Expr; readonly caption?: Expr }
    | {
        readonly kind: "chart";
        readonly data: string;
        readonly chart: "bar" | "line" | "area" | "donut";
        /** The category or time field. */
        readonly x: string;
        /** One or more numeric fields. */
        readonly y: readonly string[];
        /** A band to shade, such as a permitted range. */
        readonly band?: { readonly from: Expr; readonly to: Expr; readonly label?: string };
        readonly format?: ValueFormat;
      }
    | {
        readonly kind: "table";
        readonly data: string;
        readonly columns: readonly FieldRefIR[];
        /** Selecting a row sets this state to the row's id. */
        readonly select?: string;
        readonly onSelect?: readonly EffectIR[];
        readonly groupBy?: string;
        /** Fields the person may filter on. */
        readonly filters?: readonly string[];
        readonly search?: boolean;
        readonly pageSize?: number;
        /** Per-row buttons; `$row` is the row. */
        readonly rowActions?: readonly { readonly label: string; readonly do: readonly EffectIR[]; readonly when?: Expr }[];
        readonly empty?: string;
      }
    | { readonly kind: "detail"; readonly data: string; readonly fields: readonly FieldRefIR[]; readonly provenance?: boolean; readonly headline?: string }
    | { readonly kind: "timeline"; readonly data: string; readonly time: string; readonly label: Expr; readonly detail?: Expr; readonly tone?: Expr }
    | { readonly kind: "graph"; readonly root: string; readonly relationships: readonly string[]; readonly label?: Readonly<Record<string, string>> }
    | { readonly kind: "map"; readonly data: string; readonly lat: string; readonly lon: string; readonly label: Expr; readonly tone?: Expr; readonly select?: string; readonly region?: "us" | "world" }
    | { readonly kind: "form"; readonly action?: string; readonly flow?: string; readonly defaults?: Readonly<Record<string, Expr>>; readonly fields?: readonly string[]; readonly submitLabel?: string; readonly then?: readonly EffectIR[]; readonly into?: string }
    | { readonly kind: "approvals"; readonly flows?: readonly string[]; readonly present?: readonly string[] }
    | { readonly kind: "run"; readonly run: Expr; readonly flow: string }
    | { readonly kind: "assistant"; readonly flow: string; readonly input: Readonly<Record<string, Expr>>; readonly step: string; readonly prompt?: string; readonly into?: string }
    | { readonly kind: "provenance"; readonly data: string; readonly property: string }
    | { readonly kind: "actions"; readonly buttons: readonly { readonly label: string; readonly do: readonly EffectIR[]; readonly when?: Expr; readonly tone?: "primary" | "neutral" | "danger" }[] }
    | { readonly kind: "custom"; readonly component: string; readonly props: Readonly<Record<string, Expr>>; readonly propTypes: Readonly<Record<string, JsonSchema2020>> }
  );

export type NodeKind = NodeIR["kind"];

export interface PageIR {
  /** PascalCase, unique: the page's component. */
  readonly name: string;
  readonly title: string;
  /** `/`, `/shipments/:id`: each `:param` is a page parameter. */
  readonly path: string;
  readonly description?: string;
  readonly params?: Readonly<Record<string, { readonly schema: JsonSchema2020; readonly objectOf?: string }>>;
  readonly state?: Readonly<Record<string, StateIR>>;
  readonly data?: Readonly<Record<string, DataIR>>;
  /** Callers the page is listed for in navigation. Presentation only: the runtime still decides every value. */
  readonly for?: readonly string[];
  /** Shown in navigation. Default true for a page without parameters. */
  readonly nav?: boolean;
  readonly layout: NodeIR;
}

/** How the application looks: a design system and its tokens, kept apart from what it does. */
export interface DesignIR {
  /** A design system `@typesys/ui` ships (`meridian`, `ledger`), or `<module>#<export>` in `src/extensions/`. */
  readonly system: string;
  readonly tokens?: Readonly<Record<string, string>>;
  readonly density?: "comfortable" | "compact";
  readonly brand?: { readonly name: string; readonly mark?: string };
}

/**
 * What the browser shows a caller, checked in Chromium: nodes present or
 * absent, text present or absent, and how many rows a table shows.
 */
export interface ScreenCheck {
  readonly id: string;
  readonly kind: "screen";
  readonly as: string;
  readonly page: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly because?: string;
  readonly visible?: readonly string[];
  readonly hidden?: readonly string[];
  readonly text?: readonly string[];
  readonly absentText?: readonly string[];
  readonly rows?: Readonly<Record<string, { readonly atLeast?: number; readonly atMost?: number }>>;
}

export type AppCheck = AcceptanceCheck | ScreenCheck;

export interface AppSpec {
  readonly format: typeof APP_FORMAT;
  /** Lower case words joined by `-`. */
  readonly name: string;
  readonly title: string;
  /** The requirement in a person's words. */
  readonly requirement: string;
  readonly host: MissionHost;
  readonly callers: Readonly<Record<string, MissionCaller>>;
  /** The LLM configuration (`typesys.llm.json`, ADR-0074), relative to the application. Required when a flow has an AI step. */
  readonly llm?: string;
  readonly models?: Readonly<Record<string, ModelRoleIR>>;
  readonly design?: DesignIR;
  readonly state?: Readonly<Record<string, StateIR>>;
  readonly data?: Readonly<Record<string, DataIR>>;
  readonly flows?: Readonly<Record<string, FlowIR>>;
  readonly pages: readonly PageIR[];
  readonly acceptance: readonly AppCheck[];
}
