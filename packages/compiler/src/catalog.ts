import type { ExprOp, NodeKind, StepKind } from "./ir.js";

/**
 * The composition primitives and their contracts, as data (ADR-0079). The
 * parser validates against this table, `typesys app catalog` prints it, and
 * the MCP tool returns it: an agent learns the whole language here, in a
 * few thousand tokens, rather than from the compiler's source.
 */
export type PropKind =
  | "string"
  | "number"
  | "boolean"
  | "expr"
  | "expr-map"
  | "schema"
  | "schema-map"
  | "data"
  | "state"
  | "field"
  | "fields"
  | "field-refs"
  | "strings"
  | "effects"
  | "node"
  | "nodes"
  | "tabs"
  | "buttons"
  | "row-actions"
  | "flow"
  | "action"
  | "page"
  | "step"
  | "enum"
  | "band"
  | "string-map";

export interface PropSpec {
  readonly kind: PropKind;
  readonly required?: boolean;
  readonly values?: readonly string[];
  readonly doc: string;
}

export interface PrimitiveSpec {
  readonly doc: string;
  readonly props: Readonly<Record<string, PropSpec>>;
}

const FORMATS = ["text", "number", "integer", "percent", "currency", "date", "date-time", "relative-time", "duration-minutes", "badge", "boolean", "temperature"] as const;
const TONES = ["neutral", "info", "good", "warn", "bad"] as const;

/** Props every node takes. */
export const NODE_BASE: Readonly<Record<string, PropSpec>> = {
  kind: { kind: "string", required: true, doc: "Which node." },
  id: { kind: "string", doc: "Stable id: what a screen check, a test or an extension names." },
  title: { kind: "string", doc: "Heading shown above it." },
  span: { kind: "number", doc: "Columns of the parent grid it spans, 1 to 12." },
  when: { kind: "expr", doc: "Shown only when true. Presentation only: the runtime decides what data holds." }
};

export const NODE_CATALOG: Readonly<Record<NodeKind, PrimitiveSpec>> = {
  grid: { doc: "Children on a responsive grid of `columns` (default 12); each child spans `span` columns and stacks on narrow screens.", props: { columns: { kind: "number", doc: "1 to 12." }, children: { kind: "nodes", required: true, doc: "The nodes on the grid." } } },
  stack: { doc: "Children in a row or a column.", props: { direction: { kind: "enum", values: ["row", "column"], doc: "Default column." }, children: { kind: "nodes", required: true, doc: "The nodes." } } },
  tabs: { doc: "Labelled panels, one shown at a time, keyboard navigable.", props: { tabs: { kind: "tabs", required: true, doc: "[{ label, content }]" } } },
  section: { doc: "A titled panel around its children.", props: { children: { kind: "nodes", required: true, doc: "The nodes." }, description: { kind: "string", doc: "A line under the title." } } },
  text: { doc: "A line of text, which may interpolate values with concat.", props: { text: { kind: "expr", required: true, doc: "A string expression." }, tone: { kind: "enum", values: TONES, doc: "Colour of meaning." } } },
  metric: {
    doc: "A key figure (KPI): a value, its label, an optional tone and caption.",
    props: {
      label: { kind: "string", required: true, doc: "What it measures." },
      value: { kind: "expr", required: true, doc: "A number (or string) expression over data." },
      format: { kind: "enum", values: FORMATS, doc: "How the value is shown." },
      tone: { kind: "expr", doc: `An expression giving one of ${TONES.join(", ")}.` },
      caption: { kind: "expr", doc: "A line under the value." }
    }
  },
  chart: {
    doc: "A bar, line, area or donut chart of list data: `x` is the category or time field, `y` one or more numeric fields; `band` shades a range.",
    props: {
      data: { kind: "data", required: true, doc: "List data (a query, related read, aggregate or derived list)." },
      chart: { kind: "enum", values: ["bar", "line", "area", "donut"], required: true, doc: "The chart." },
      x: { kind: "field", required: true, doc: "Category or time field of each element (`key.status` for an aggregate)." },
      y: { kind: "fields", required: true, doc: "Numeric fields (`values.count` for an aggregate)." },
      band: { kind: "band", doc: "{ from, to, label }: a range to shade, such as a permitted temperature." },
      format: { kind: "enum", values: FORMATS, doc: "How y values are shown." }
    }
  },
  table: {
    doc: "An interactive table: sort, filter, search, group and page on the client over what the runtime returned; select a row; per-row actions.",
    props: {
      data: { kind: "data", required: true, doc: "List data." },
      columns: { kind: "field-refs", required: true, doc: 'Fields, or { field, label, format, tone: { "<value>": "<tone>" } }.' },
      select: { kind: "state", doc: "State set to the selected row's $id." },
      onSelect: { kind: "effects", doc: "Effects run on selecting a row; $row is the row." },
      groupBy: { kind: "field", doc: "Group rows by this field." },
      filters: { kind: "fields", doc: "Fields the person may filter on." },
      search: { kind: "boolean", doc: "A search box over the rows." },
      pageSize: { kind: "number", doc: "Rows per page; default 25." },
      rowActions: { kind: "row-actions", doc: "[{ label, do: [effects], when }]; $row is the row." },
      empty: { kind: "string", doc: "What to say when there are no rows." }
    }
  },
  detail: {
    doc: "One object's fields, each with its provenance on request; withheld fields are shown as withheld, never as empty.",
    props: {
      data: { kind: "data", required: true, doc: "Object data." },
      fields: { kind: "field-refs", required: true, doc: "Fields to show." },
      provenance: { kind: "boolean", doc: "Offer where each value came from (ADR-0016)." },
      headline: { kind: "field", doc: "The field shown as the title." }
    }
  },
  timeline: {
    doc: "Events in time order: list data, the time field, a label and detail expression over $item, and a tone.",
    props: {
      data: { kind: "data", required: true, doc: "List data." },
      time: { kind: "field", required: true, doc: "A date-time field." },
      label: { kind: "expr", required: true, doc: "Over $item." },
      detail: { kind: "expr", doc: "Over $item." },
      tone: { kind: "expr", doc: "Over $item: one of the tones." }
    }
  },
  graph: {
    doc: "An object and what its relationships reach, explored by clicking: each related object is read through the runtime as the caller.",
    props: {
      root: { kind: "data", required: true, doc: "Object data to start from." },
      relationships: { kind: "strings", required: true, doc: "Relationships to follow, as `Type.relationship` or a relationship of the root's Type." },
      label: { kind: "string-map", doc: "Type → field shown as each node's label." }
    }
  },
  map: {
    doc: "Points on a map (an offline US or world outline): list data with latitude and longitude fields, a label and tone over $item; selecting a point sets state.",
    props: {
      data: { kind: "data", required: true, doc: "List data." },
      lat: { kind: "field", required: true, doc: "Latitude field." },
      lon: { kind: "field", required: true, doc: "Longitude field." },
      label: { kind: "expr", required: true, doc: "Over $item." },
      tone: { kind: "expr", doc: "Over $item: one of the tones." },
      select: { kind: "state", doc: "State set to the selected point's $id." },
      region: { kind: "enum", values: ["us", "world"], doc: "Default us." }
    }
  },
  form: {
    doc: "A form for an Action's input (previewed by the runtime, then confirmed) or a flow's input (started as the person); fields come from the input schema.",
    props: {
      action: { kind: "action", doc: "An Action to invoke." },
      flow: { kind: "flow", doc: "A flow to start." },
      defaults: { kind: "expr-map", doc: "Input → expression; a defaulted field the person is not shown unless listed in fields." },
      fields: { kind: "strings", doc: "Inputs the person fills in; default every input not defaulted." },
      submitLabel: { kind: "string", doc: "The button." },
      then: { kind: "effects", doc: "Effects after it succeeds; $result is the answer." },
      into: { kind: "state", doc: "State set to the started run's id (flows)." }
    }
  },
  approvals: { doc: "The signed-in person's approval queue: each run waiting on an approval their policy admits, with what the run presents, as they may read it.", props: { flows: { kind: "strings", doc: "Only these flows." } } },
  run: { doc: "One run of a flow: its status and each step's progress, live while it runs.", props: { run: { kind: "expr", required: true, doc: "The run id, usually state." }, flow: { kind: "flow", required: true, doc: "The flow." } } },
  assistant: {
    doc: "Contextual AI: runs a flow (governed reads and an AI step, released for the model's audience) on request and shows the AI step's answer.",
    props: {
      flow: { kind: "flow", required: true, doc: "A flow with the AI step." },
      input: { kind: "expr-map", required: true, doc: "The flow's input." },
      step: { kind: "step", required: true, doc: "The AI step whose answer is shown." },
      prompt: { kind: "string", doc: "The button's words." },
      into: { kind: "state", doc: "State set to the run id." }
    }
  },
  provenance: { doc: "Where one value of an object came from: system, record, field, time and confidence, and the inputs of a computed value.", props: { data: { kind: "data", required: true, doc: "Object data." }, property: { kind: "string", required: true, doc: "The value." } } },
  actions: { doc: "Buttons, each running effects.", props: { buttons: { kind: "buttons", required: true, doc: "[{ label, do: [effects], when, tone }]" } } },
  custom: {
    doc: "A React component you write in src/extensions/: the compiler generates its props type from propTypes and passes the expressions, typed.",
    props: {
      component: { kind: "string", required: true, doc: "<module>#<export>, the module relative to src/extensions/." },
      props: { kind: "expr-map", required: true, doc: "Prop → expression." },
      propTypes: { kind: "schema-map", required: true, doc: "Prop → JSON Schema: the contract." }
    }
  }
};

export const STEP_CATALOG: Readonly<Record<StepKind, PrimitiveSpec>> = {
  read: { doc: "A governed read as the run's initiator.", props: { read: { kind: "string", required: true, doc: "A read: { kind: query | object | related | aggregate, … }." }, timeoutMs: { kind: "number", doc: "Fail (retryably) after this long." }, onError: { kind: "enum", values: ["fail", "continue"], doc: "continue: a source failure leaves the output unknown and the run goes on." } } },
  compute: { doc: "A pure value of earlier steps; replayed and compared, so deterministic.", props: { value: { kind: "expr", required: true, doc: "The value." } } },
  check: { doc: "Fails the run with `message` unless `assert` is true (an unknown value is not true).", props: { assert: { kind: "expr", required: true, doc: "A boolean." }, message: { kind: "string", required: true, doc: "Why the run fails." } } },
  ai: {
    doc: "Asks a configured model (ADR-0074). Its input is released for the model's audience (ADR-0067); its answer is checked against `output` and treated as a proposal: an Action with side effects that uses it needs an approval of it first.",
    props: {
      model: { kind: "string", required: true, doc: "A role in `models`." },
      prompt: { kind: "string", required: true, doc: "The instruction." },
      input: { kind: "expr-map", required: true, doc: "What the model is given." },
      output: { kind: "schema", required: true, doc: "JSON Schema the answer must satisfy." },
      release: { kind: "enum", values: ["refuse", "redact"], doc: "Default refuse." }
    }
  },
  approval: {
    doc: "Waits for a person the policy admits; never the initiator unless allowSelfApproval.",
    props: { policy: { kind: "string", required: true, doc: "A policy rule." }, present: { kind: "strings", required: true, doc: "Earlier steps the approver is shown." }, allowSelfApproval: { kind: "boolean", doc: "Default false." }, deadlineMs: { kind: "number", doc: "Expires (and compensates) after this long." } }
  },
  action: {
    doc: "Invokes an Action as the initiator: policy, input schema, preconditions and audit apply.",
    props: { action: { kind: "action", required: true, doc: "The Action." }, input: { kind: "expr-map", required: true, doc: "Its input." }, compensate: { kind: "string", doc: "{ action, input }: undoes it; $output is this Action's output." } }
  },
  parallel: { doc: "Reads that do not depend on one another, run at once; each is referred to by its own name.", props: { steps: { kind: "string", required: true, doc: "Read steps." } } },
  forEach: {
    doc: "One read per element of a list ($item), at most `max`: a longer list fails the step rather than being cut short.",
    props: { over: { kind: "expr", required: true, doc: "A list." }, max: { kind: "number", required: true, doc: "Most elements." }, read: { kind: "string", required: true, doc: "The read, over $item." }, concurrency: { kind: "number", doc: "Reads at once; default 4." } }
  }
};

/** Props every step takes. */
export const STEP_BASE: Readonly<Record<string, PropSpec>> = {
  kind: { kind: "string", required: true, doc: "Which step." },
  name: { kind: "string", required: true, doc: "camelCase; later steps refer to its output as $<name>." },
  description: { kind: "string", doc: "What it is for." },
  when: { kind: "expr", doc: "Runs only when true; otherwise skipped, and its output unknown." },
  retry: { kind: "string", doc: "{ maxAttempts, backoffMs }: only on retryable errors." }
};

export const EFFECT_CATALOG: Readonly<Record<string, string>> = {
  set: '{ "set": "<state>", "value": expr }: set page or application state.',
  run: '{ "run": "<flow>", "input": { … }, "into"?: "<state>" }: start a flow as the person; into receives the run id.',
  invoke: '{ "invoke": "<Action>", "input": { … } }: preview with the runtime, show the person what it would do, invoke on confirmation.',
  navigate: '{ "navigate": "<Page>", "params"?: { … } }: go to a page.',
  refresh: '{ "refresh": ["<data>", …] }: read data again.'
};

export const OP_CATALOG: Readonly<Record<ExprOp, string>> = {
  eq: "[a, b] → boolean; same type", ne: "[a, b] → boolean", lt: "[a, b] → boolean; numbers or date-times", lte: "[a, b]", gt: "[a, b]", gte: "[a, b]",
  in: "[a, list] → boolean", and: "[bool, bool, …]", or: "[bool, bool, …]", not: "bool → bool", exists: "a → boolean: known (not withheld, skipped or null)",
  if: "[cond, then, else]", coalesce: "[a, b, …] → the first known", add: "[n, n, …]", sub: "[n, n]", mul: "[n, n, …]", div: "[n, n]", round: "[n] or [n, digits]",
  concat: "[s, s, …] → string", count: "list → integer", sum: "[list] or [list, field] → number", avg: "[list] or [list, field]", min: "[list] or [list, field]", max: "[list] or [list, field]",
  where: "[list, predicate over $item] → list", pluck: "[list, field] → list", hoursSince: "date-time → number (interface only)"
};

/** References: what each `$scope` names, and where. */
export const SCOPES: Readonly<Record<string, string>> = {
  $input: "A flow's input (flows).",
  "$<step>": "An earlier step's output (flows).",
  $output: "The compensated Action's output (a compensation).",
  $item: "The element (forEach, where, timeline, map).",
  $row: "The row (table columns and row actions).",
  $state: "Application and page state (interface).",
  $params: "The page's parameters (interface).",
  "$<data>": "Application or page data (interface).",
  $me: "The signed-in caller: { subjectId, roles } (interface).",
  $result: "The answer of the effect before (a form's then)."
};
