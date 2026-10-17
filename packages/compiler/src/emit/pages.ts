import { formFields } from "@typesys/react";
import type { JsonSchema2020 } from "@typesys/core";
import type { AppAnalysis, DataInfo, PageInfo } from "../check.js";
import { isLiteral, isRef, parseRef } from "../expr.js";
import type { EffectIR, Expr, FieldRefIR, NodeIR, StateIR } from "../ir.js";
import { schemaToTy, tsType } from "../types.js";
import { GENERATED } from "./flows.js";
import { readTs, usesCombinators, valueTs } from "./reads.js";
import { comment, exprTs, fnModules, ident, moduleAlias, q, type ExprTarget } from "./ts.js";

/** Names a generated page already uses for itself, which data are renamed around. */
const RESERVED = new Set(["state", "setState", "local", "useRead", "at", "keyOf", "toNumber", "toText", "typedRead", "useDerived", "usePageState", "useEffects", "useRuntime", "params", "me", "fx", "client", "row", "item", "result", "id", "i", "$", "need", "rows", "and", "or", "props", "default", "new", "delete", "class", "function", "return", "this", "void", "in", "of", "let", "var", "const", "true", "false", "null", "undefined"]);

/** The variable a page holds data in: its own name, unless that is one the page needs. */
export const dataVar = (name: string): string => (RESERVED.has(name) ? `${name}Data` : name);

/** Every `$head` an expression (or a node, or a list of effects) references, outside literals. */
export function refHeads(e: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof e === "string") {
    const r = isRef(e) ? parseRef(e) : undefined;
    if (r) into.add(r.head);
  } else if (Array.isArray(e)) e.forEach((x) => refHeads(x, into));
  else if (e && typeof e === "object" && !isLiteral(e)) Object.values(e as Record<string, unknown>).forEach((x) => refHeads(x, into));
  return into;
}

/**
 * One page as a React component (ADR-0082). Each datum is a `useRead` (or a
 * `useDerived`) over the generated, typed client, reading again when what it
 * references changes and after anything changes a Type it reads; each node
 * is a `@typesys/ui` component given those data and the page's effects. It
 * holds no behaviour of its own beyond what the IR says, so reviewing the
 * page is reviewing the IR.
 */
export function pageSource(info: PageInfo, analysis: AppAnalysis): string {
  const { page } = info;
  const ui = new Set<string>(["PageHeader", "useEffects", "usePageState", ...(JSON.stringify(info.page).includes('"$me') ? ["useRuntime"] : [])]);
  const app = new Set<string>(["$"]);
  const sdk = { and: false, or: false };
  const modules = new Set<string>();
  const dataNames = new Set(Object.keys(info.data));

  const target = (extra: Record<string, string> = {}): ExprTarget => ({
    ref: (head) => {
      if (Object.hasOwn(extra, head)) return extra[head]!;
      if (head === "state" || head === "params" || head === "me") return head;
      if (dataNames.has(head)) return `${dataVar(head)}.value`;
      throw new TypeError(`$${head} names nothing on page ${page.name}`);
    }
  });
  const ex = (e: Expr, t: ExprTarget = target()) => {
    for (const m of fnModules(e)) modules.add(m);
    return exprTs(e, t);
  };
  /** An expression a governed call takes as a value it cannot do without. */
  const needed = (e: Expr, what: string, t: ExprTarget = target()) => {
    for (const m of fnModules(e)) modules.add(m);
    const v = valueTs(e, t, what);
    if (v.startsWith("need(")) app.add("need");
    return v;
  };
  const dataIn = (e: unknown): string[] => [...refHeads(e)].filter((h) => dataNames.has(h));

  // ---------------------------------------------------------------- data
  // Only the application's data this page uses (directly or through other data) are read here.
  const used = new Set<string>();
  const visit = (name: string) => {
    if (used.has(name) || !info.data[name]) return;
    used.add(name);
    info.data[name].deps.data.forEach(visit);
  };
  for (const h of refHeads(page.layout)) visit(h);
  for (const h of dataRefsIn(page.layout)) visit(h);
  for (const name of Object.keys(page.data ?? {})) visit(name);

  const dataLines: string[] = [];
  for (const d of Object.values(info.data)) {
    if (!used.has(d.name)) continue;
    dataLines.push(...dataDecl(d));
  }

  function dataDecl(d: DataInfo): string[] {
    const v = dataVar(d.name);
    const doc = d.decl.description ? [`  /** ${comment(d.decl.description)} */`] : [];
    if (d.decl.kind === "derive") {
      ui.add("useDerived");
      const from = d.deps.data.map(dataVar);
      return [...doc, `  const ${v} = useDerived(() => ${ex(d.decl.value)}, [${from.join(", ")}]);`];
    }
    const t = target();
    const u = usesCombinators(d.decl);
    sdk.and ||= u.and;
    sdk.or ||= u.or;
    if (d.decl.kind === "query") app.add("rows");
    const call = readTs(d.decl, t);
    if (call.includes("need(")) app.add("need");
    for (const m of fnModules(d.decl)) modules.add(m);
    const deps = [...d.deps.state.map((s) => `state${accessOf(s)}`), ...d.deps.params.map((p) => `params${accessOf(p)}`), ...d.deps.data.map((x) => `${dataVar(x)}.value`)];
    const opts: string[] = [];
    if (d.types.length) opts.push(`types: ${JSON.stringify([...d.types].sort())}`);
    if (d.decl.refresh?.everyMs) opts.push(`everyMs: ${d.decl.refresh.everyMs}`);
    return [...doc, `  const ${v} = useRead((client) => ${call}, [${deps.join(", ")}]${opts.length ? `, { ${opts.join(", ")} }` : ""});`];
  }

  // ---------------------------------------------------------------- effects
  const typeOfAction = (name: string): string[] => {
    const a = analysis.model.actions.find((x) => x.name === name);
    return [...new Set([...(a?.target ? [a.target.type] : []), ...(a?.applicableTypes ?? [])])].sort();
  };
  const flowTypes = (key: string): string[] => {
    const f = analysis.flows[key];
    return f ? [...new Set([...f.writes, ...f.reads])].sort() : [];
  };
  const flowName = (key: string) => analysis.flows[key]?.flow.name ?? key;

  const actionInput = (action: string, input: Readonly<Record<string, Expr>>, t: ExprTarget): string => {
    const a = analysis.model.actions.find((x) => x.name === action);
    const required = new Set(Array.isArray(a?.inputSchema.required) ? a.inputSchema.required : []);
    return `{ ${Object.entries(input)
      .map(([k, v]) => `${ident(k)}: ${required.has(k) ? needed(v, `input "${k}"`, t) : ex(v, t)}`)
      .join(", ")} }`;
  };
  const flowInput = (input: Readonly<Record<string, Expr>>, t: ExprTarget): string =>
    `{ ${Object.entries(input)
      .map(([k, v]) => `${ident(k)}: ${needed(v, `input "${k}"`, t)}`)
      .join(", ")} }`;

  /** Each effect as statements; one that fails or is cancelled returns, so the rest do not run. */
  const effects = (list: readonly EffectIR[], t: ExprTarget): string[] =>
    list.flatMap((e) => {
      if ("set" in e) return [`fx.set(${q(e.set)}, ${ex(e.value, t)});`];
      if ("run" in e) {
        const f = analysis.flows[e.run];
        const call = `fx.run(${q(flowName(e.run))}, () => (${flowInput(e.input, t)}), { invalidates: ${JSON.stringify(flowTypes(e.run))}, title: ${q(f?.flow.title ?? humanName(flowName(e.run)))} })`;
        if (!e.into) return [`if ((await ${call}) === undefined) return;`];
        return ["{", `  const run = await ${call};`, "  if (!run) return;", `  fx.set(${q(e.into)}, run.runId);`, "}"];
      }
      if ("invoke" in e) {
        const opts = [`invalidates: ${JSON.stringify(typeOfAction(e.invoke))}`, ...(e.confirm === false ? ["confirm: false"] : [])];
        return [`if ((await fx.invoke(${q(e.invoke)}, () => (${actionInput(e.invoke, e.input, t)}), { ${opts.join(", ")} })) === undefined) return;`];
      }
      if ("navigate" in e) {
        const params = Object.entries(e.params ?? {}).map(([k, v]) => `${ident(k)}: ${needed(v, `page parameter "${k}"`, t)}`);
        return [`fx.navigate(${q(e.navigate)}${params.length ? `, { ${params.join(", ")} }` : ""});`];
      }
      return [`fx.refresh(${e.refresh.map(dataVar).join(", ")});`];
    });
  /** An interaction: its effects in order, a failure shown to the person. `pad` is the indentation it starts at. */
  const handler = (args: string, list: readonly EffectIR[], t: ExprTarget, pad: string, before: string[] = []): string => {
    const body = [...before, ...effects(list, t)];
    return `(${args}) =>\n${pad}  fx.guard(async () => {\n${body.map((l) => `${pad}    ${l}`).join("\n")}\n${pad}  })`;
  };

  // ---------------------------------------------------------------- nodes
  const attrs = (n: NodeIR, extra: Record<string, string | undefined>): string => {
    const base: Record<string, string | undefined> = {
      id: n.id === undefined ? undefined : q(n.id),
      title: n.title === undefined ? undefined : q(n.title),
      span: n.span === undefined ? undefined : `{${n.span}}`,
      ...extra
    };
    return Object.entries(base)
      .filter(([, v]) => v !== undefined)
      // A value is a JSX expression container already (`{…}`), or a string literal, which goes in one: JSX attribute strings have no escapes.
      .map(([k, v]) => `${k}=${v!.startsWith("{") ? v : `{${v}}`}`)
      .join(" ");
  };
  const lit = (v: unknown) => `{${JSON.stringify(v)}}`;
  const pending = (exprs: unknown[]): string | undefined => {
    const ds = [...new Set(exprs.flatMap(dataIn))].map(dataVar);
    return ds.length ? `{[${ds.join(", ")}]}` : undefined;
  };
  const columns = (cols: readonly FieldRefIR[]) => JSON.stringify(cols.map((c) => (typeof c === "string" ? { field: c } : c)));
  const semanticOf = (data: string): string | undefined => {
    const ty = info.data[data]?.typed.ty;
    return ty?.t === "object" ? ty.semantic : ty?.t === "list" && ty.of.t === "object" ? ty.of.semantic : undefined;
  };

  const node = (n: NodeIR, depth: number): string => {
    const pad = "  ".repeat(depth);
    const inner = render(n, depth);
    if (n.when === undefined) return `${pad}${inner}`;
    return `${pad}{$.holds(${ex(n.when)}) ? (\n${pad}  ${inner}\n${pad}) : null}`;
  };
  const kids = (children: readonly NodeIR[], depth: number) => children.map((c) => node(c, depth + 1)).join("\n");

  function render(n: NodeIR, depth: number): string {
    const pad = "  ".repeat(depth);
    const close = (tag: string, a: string, children: string) => `<${tag}${a ? ` ${a}` : ""}>\n${children}\n${pad}</${tag}>`;
    switch (n.kind) {
      case "grid":
        ui.add("Grid");
        return close("Grid", attrs({ ...n, title: undefined }, { columns: n.columns === undefined ? undefined : `{${n.columns}}` }), kids(n.children, depth));
      case "stack":
        ui.add("Stack");
        return close("Stack", attrs({ ...n, title: undefined }, { direction: n.direction === undefined ? undefined : q(n.direction) }), kids(n.children, depth));
      case "section":
        ui.add("Section");
        return close("Section", attrs(n, { description: n.description === undefined ? undefined : q(n.description) }), kids(n.children, depth));
      case "tabs": {
        ui.add("Tabs");
        const tabs = n.tabs.map((t) => `${pad}  { label: ${q(t.label)}, content: (\n${pad}    <>\n${node(t.content, depth + 3)}\n${pad}    </>\n${pad}  ) }`);
        return `<Tabs ${attrs({ ...n, title: undefined }, { tabs: `{[\n${tabs.join(",\n")}\n${pad}]}` })} />`;
      }
      case "text":
        ui.add("Text");
        ui.add("toText");
        return `<Text ${attrs(n, { text: `{toText(${ex(n.text)})}`, tone: n.tone === undefined ? undefined : q(n.tone) })} />`;
      case "metric":
        ui.add("Metric");
        return `<Metric ${attrs(n, {
          label: q(n.label),
          value: `{${ex(n.value)}}`,
          format: n.format === undefined ? undefined : q(n.format),
          tone: n.tone === undefined ? undefined : `{${ex(n.tone)}}`,
          caption: n.caption === undefined ? undefined : `{${ex(n.caption)}}`,
          pending: pending([n.value, n.tone, n.caption])
        })} />`;
      case "chart": {
        ui.add("Chart");
        ui.add("toNumber");
        const band = n.band ? `{{ from: toNumber(${ex(n.band.from)}), to: toNumber(${ex(n.band.to)})${n.band.label ? `, label: ${q(n.band.label)}` : ""} }}` : undefined;
        return `<Chart ${attrs(n, {
          data: `{${dataVar(n.data)}}`,
          chart: q(n.chart),
          x: q(n.x),
          y: lit(n.y),
          band,
          format: n.format === undefined ? undefined : q(n.format),
          pending: pending([n.band])
        })} />`;
      }
      case "table": {
        ui.add("Table");
        const rowT = target({ row: "row" });
        const select = n.select ? [`fx.set(${q(n.select)}, row.$id);`] : [];
        const onSelect = n.select || n.onSelect ? `{${handler("row", n.onSelect ?? [], rowT, pad, select)}}` : undefined;
        const rowActions = n.rowActions?.length
          ? `{[\n${n.rowActions
              .map((ra) => `${pad}  { label: ${q(ra.label)}${ra.when !== undefined ? `, when: (row) => $.holds(${ex(ra.when, rowT)})` : ""}, onClick: ${handler("row", ra.do, rowT, `${pad}  `)} }`)
              .join(",\n")}\n${pad}]}`
          : undefined;
        return `<Table ${attrs(n, {
          data: `{${dataVar(n.data)}}`,
          columns: `{${columns(n.columns)}}`,
          selected: n.select ? `{${`state${accessOf(n.select)}`} ?? null}` : undefined,
          onSelect,
          groupBy: n.groupBy === undefined ? undefined : q(n.groupBy),
          filters: n.filters ? lit(n.filters) : undefined,
          search: n.search ? "{true}" : undefined,
          pageSize: n.pageSize === undefined ? undefined : `{${n.pageSize}}`,
          rowActions,
          empty: n.empty === undefined ? undefined : q(n.empty)
        })} />`;
      }
      case "detail": {
        ui.add("Detail");
        const type = semanticOf(n.data);
        return `<Detail ${attrs(n, {
          data: `{${dataVar(n.data)}}`,
          fields: `{${columns(n.fields)}}`,
          headline: n.headline === undefined ? undefined : q(n.headline),
          provenance: n.provenance ? "{true}" : undefined,
          type: type ? q(type) : undefined
        })} />`;
      }
      case "timeline": {
        ui.add("Timeline");
        ui.add("toText");
        ui.add("keyOf");
        ui.add("at");
        const it = target({ item: "item" });
        const items = `{(${dataVar(n.data)}.value ?? []).map((item, i) => ({ key: keyOf(item, i), time: toText(at(item, ${q(n.time)})), label: toText(${ex(n.label, it)})${n.detail !== undefined ? `, detail: toText(${ex(n.detail, it)})` : ""}${n.tone !== undefined ? `, tone: ${ex(n.tone, it)}` : ""} }))}`;
        return `<Timeline ${attrs(n, { data: `{${dataVar(n.data)}}`, items })} />`;
      }
      case "graph": {
        ui.add("Graph");
        const rootType = semanticOf(n.root);
        const rels = n.relationships.flatMap((rel) => {
          const qualified = /^[a-z].*\.[A-Z][^.]*\./.test(rel);
          const from = qualified ? rel.slice(0, rel.lastIndexOf(".")) : rootType;
          const name = qualified ? rel.slice(rel.lastIndexOf(".") + 1) : rel;
          const t = analysis.model.types.find((x) => x.name === from)?.relationships.find((r) => r.name === name);
          return from && t ? [{ from, name, target: t.target }] : [];
        });
        return `<Graph ${attrs(n, { root: `{${dataVar(n.root)}}`, relationships: lit(rels), labels: n.label ? lit(n.label) : undefined })} />`;
      }
      case "map": {
        ui.add("MapView");
        ui.add("toText");
        ui.add("toNumber");
        ui.add("keyOf");
        ui.add("at");
        const it = target({ item: "item" });
        const points = `{(${dataVar(n.data)}.value ?? []).map((item, i) => ({ id: keyOf(item, i), lat: toNumber(at(item, ${q(n.lat)})), lon: toNumber(at(item, ${q(n.lon)})), label: toText(${ex(n.label, it)})${n.tone !== undefined ? `, tone: ${ex(n.tone, it)}` : ""} }))}`;
        return `<MapView ${attrs(n, {
          data: `{${dataVar(n.data)}}`,
          points,
          region: n.region === undefined ? undefined : q(n.region),
          selected: n.select ? `{${`state${accessOf(n.select)}`} ?? null}` : undefined,
          onSelect: n.select ? `{(id) => fx.set(${q(n.select)}, id)}` : undefined
        })} />`;
      }
      case "form": {
        ui.add("Form");
        const isAction = n.action !== undefined;
        const schema: JsonSchema2020 = isAction
          ? analysis.model.actions.find((a) => a.name === n.action)!.inputSchema
          : (() => {
              const f = analysis.flows[n.flow!]!.flow;
              return { type: "object", properties: Object.fromEntries(Object.entries(f.input).map(([k, v]) => [k, v.schema])), required: Object.keys(f.input) };
            })();
        const target0 = isAction ? analysis.model.actions.find((a) => a.name === n.action)!.target : undefined;
        const all = formFields({ inputSchema: schema, ...(target0 ? { target: target0 } : {}) });
        const shown = n.fields ? n.fields.map((f) => all.find((x) => x.name === f)!).filter(Boolean) : all.filter((f) => !Object.hasOwn(n.defaults ?? {}, f.name));
        const required = new Set(Array.isArray((schema as { required?: unknown }).required) ? ((schema as { required: string[] }).required) : []);
        const defaults = Object.entries(n.defaults ?? {}).map(([k, v]) => `${ident(k)}: ${required.has(k) ? needed(v, `input "${k}"`) : ex(v)}`);
        const resultT = target({ result: "(result as ResultValue)" });
        const then = n.then?.length || n.into ? handler("result", n.then ?? [], resultT, pad, n.into ? [`fx.set(${q(n.into)}, (result as ResultValue)?.runId);`] : []) : undefined;
        if (then) ui.add("ResultValue");
        return `<Form ${attrs(n, {
          fx: "{fx}",
          target: `{{ kind: ${q(isAction ? "action" : "flow")}, name: ${q(isAction ? n.action : flowName(n.flow!))} }}`,
          fields: lit(shown),
          defaults: defaults.length ? `{() => ({ ${defaults.join(", ")} })}` : undefined,
          submitLabel: n.submitLabel === undefined ? undefined : q(n.submitLabel),
          invalidates: lit(isAction ? typeOfAction(n.action) : flowTypes(n.flow!)),
          then: then ? `{${then}}` : undefined
        })} />`;
      }
      case "approvals": {
        ui.add("Approvals");
        const keys = n.flows ?? Object.keys(analysis.flows);
        const names = keys.map(flowName);
        return `<Approvals ${attrs(n, {
          flows: lit(names),
          invalidates: lit(Object.fromEntries(keys.map((k) => [flowName(k), flowTypes(k)]))),
          titles: lit(Object.fromEntries(keys.map((k) => [flowName(k), analysis.flows[k]?.flow.title ?? humanName(flowName(k))])))
        })} />`;
      }
      case "run":
        ui.add("RunView");
        ui.add("toText");
        return `<RunView ${attrs(n, { run: `{toText(${ex(n.run)})}`, flowTitle: q(analysis.flows[n.flow]?.flow.title ?? humanName(flowName(n.flow))) })} />`;
      case "assistant": {
        ui.add("Assistant");
        const f = analysis.flows[n.flow]!.flow;
        const step = f.steps.find((s) => s.name === n.step);
        const role = step && step.kind === "ai" ? step.model : undefined;
        const model = role ? analysis.app.models?.[role]?.id : undefined;
        return `<Assistant ${attrs(n, {
          fx: "{fx}",
          flow: q(f.name),
          input: `{() => (${flowInput(n.input, target())})}`,
          step: q(n.step),
          prompt: n.prompt === undefined ? undefined : q(n.prompt),
          into: n.into ? `{(runId) => fx.set(${q(n.into)}, runId)}` : undefined,
          model: model ? q(model) : undefined
        })} />`;
      }
      case "provenance": {
        ui.add("Provenance");
        const type = semanticOf(n.data) ?? "";
        return `<Provenance ${attrs(n, { data: `{${dataVar(n.data)}}`, type: q(type), property: q(n.property) })} />`;
      }
      case "actions": {
        ui.add("Actions");
        const buttons = n.buttons.map(
          (b) => `${pad}  { label: ${q(b.label)}${b.tone ? `, tone: ${q(b.tone)}` : ""}${b.when !== undefined ? `, hidden: !$.holds(${ex(b.when)})` : ""}, onClick: ${handler("", b.do, target(), `${pad}  `)} }`
        );
        return `<Actions ${attrs(n, { buttons: `{[\n${buttons.join(",\n")}\n${pad}]}` })} />`;
      }
      case "custom": {
        ui.add("Frame");
        const [module, name] = n.component.split("#") as [string, string];
        modules.add(module);
        const props = Object.entries(n.props).map(([k, v]) => `${k}={${ex(v)}}`);
        const p = pending(Object.values(n.props));
        return `<Frame ${attrs(n, { kind: q("custom"), pending: p })}>\n${pad}  <${moduleAlias(module)}.${name} ${props.join(" ")} />\n${pad}</Frame>`;
      }
    }
  }

  const layout = node(page.layout, 3);
  const stateLocal = page.state ?? {};
  const stateType = Object.entries(info.state).map(([k, s]) => `  readonly ${ident(k)}: ${stateTs(s)};`);
  const ui0 = [...ui];
  if (dataLines.some((l) => l.includes("useRead("))) ui0.push("typedRead");
  const imports = [
    `import { ${[...app].sort().join(", ")} } from "@typesys/app";`,
    ...(sdk.and || sdk.or ? [`import { ${[sdk.and && "and", sdk.or && "or"].filter(Boolean).join(", ")} } from "@typesys/sdk";`] : []),
    `import { ${ui0.filter((x) => x !== "ResultValue").sort().join(", ")}${ui0.includes("ResultValue") ? ", type ResultValue" : ""} } from "@typesys/ui";`,
    ...(ui0.includes("typedRead") ? [`import type { AppModel } from "../model.js";`] : []),
    ...[...modules].sort().map((m) => `import * as ${moduleAlias(m)} from "../../extensions/${m}.js";`)
  ];
  // A page named like a component it draws (a page called Table) is declared under another name and exported as its own.
  const clash = ui0.includes(page.name);
  const component = clash ? `${page.name}Page` : page.name;
  const reads = ui0.includes("typedRead") ? "\n/** Reads through the client typed by the application's model. */\nconst useRead = typedRead<AppModel>();\n" : "";
  return `${GENERATED(`app.json /pages (${page.name})`)}
${imports.join("\n")}
${reads}
/** The state this page reads: the application's, and its own. */
export interface ${page.name}State {
${stateType.join("\n") || "  readonly [k: string]: never;"}
}

/** The page's own state, as it starts each time the page is shown. */
const local: Readonly<Record<string, unknown>> = ${JSON.stringify(Object.fromEntries(Object.entries(stateLocal).map(([k, s]) => [k, s.default ?? null])))};

/**
 * ${comment(page.title)}${page.description ? `\n *\n * ${comment(page.description)}` : ""}
 */
${clash ? `export { ${component} as ${page.name} };\n\n` : ""}${clash ? "" : "export "}function ${component}(${usesParams(page) ? "{ params }" : "_props"}: { readonly params: Readonly<Record<string, string>> }) {
  const [state, setState] = usePageState<${page.name}State>(local);
${JSON.stringify(page).includes('"$me') ? "  const { me } = useRuntime();\n" : ""}  const fx = useEffects(setState);
${dataLines.join("\n")}
  return (
    <>
      <PageHeader title={${q(page.title)}}${page.description ? ` description={${q(page.description)}}` : ""} />
${layout}
    </>
  );
}
`;
}

function usesParams(page: PageInfo["page"]): boolean {
  return JSON.stringify(page).includes('"$params');
}

/** Data names a node refers to by name (`data`, `root`) rather than by `$`. */
function dataRefsIn(n: NodeIR, into: Set<string> = new Set()): Set<string> {
  if ("data" in n && typeof n.data === "string") into.add(n.data);
  if (n.kind === "graph") into.add(n.root);
  if ("children" in n) n.children.forEach((c) => dataRefsIn(c, into));
  if (n.kind === "tabs") n.tabs.forEach((t) => dataRefsIn(t.content, into));
  return into;
}

function stateTs(s: StateIR): string {
  const t = schemaToTy(s.schema);
  return tsType(t.ty) + (t.nullable ? " | null" : "");
}

const accessOf = (seg: string): string => (/^[A-Za-z_$][\w$]*$/.test(seg) ? `.${seg}` : `[${q(seg)}]`);

/** `coldchain.DispositionExcursion` → `Disposition excursion`. */
function humanName(qualified: string): string {
  const last = qualified.split(".").pop() ?? qualified;
  const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The client entry: every page routed, the design applied, application state started from its defaults. */
export function appSource(analysis: AppAnalysis): string {
  const app = analysis.app;
  const design = app.design ?? { system: "meridian" };
  const custom = design.system.includes("#") ? (design.system.split("#") as [string, string]) : undefined;
  const presets = design.signIn === "presets" ? Object.fromEntries(Object.entries(app.callers).map(([k, c]) => [k, c.token])) : undefined;
  const initial = Object.fromEntries(Object.entries(app.state ?? {}).map(([k, s]) => [k, s.default ?? null]));
  const pages = analysis.pages.map(({ page }) => {
    const nav = page.nav ?? !page.path.includes(":");
    return `    { name: ${q(page.name)}, title: ${q(page.title)}, path: ${q(page.path)}, nav: ${nav}${page.for ? `, for: ${JSON.stringify(page.for)}` : ""}, component: ${page.name} }`;
  });
  const designTs = [
    `system: ${q(custom ? custom[0] : design.system)}`,
    ...(design.tokens ? [`tokens: ${JSON.stringify(design.tokens)}`] : []),
    ...(design.density ? [`density: ${q(design.density)}`] : []),
    ...(design.brand ? [`brand: ${JSON.stringify(design.brand)}`] : []),
    ...(custom ? [`overrides: ${moduleAlias(custom[0])}.${custom[1]}`] : [])
  ];
  return `${GENERATED("app.json")}
import { mountApp } from "@typesys/ui";
${analysis.pages.map(({ page }) => `import { ${page.name} } from "./pages/${page.name}.js";`).join("\n")}
${custom ? `import * as ${moduleAlias(custom[0])} from "../extensions/${custom[0]}.js";\n` : ""}
mountApp({
  title: ${q(app.title)},
  pages: [
${pages.join(",\n")}
  ],
  design: { ${designTs.join(", ")} },
  initialState: ${JSON.stringify(initial)}${presets ? `,\n  // Demonstration sign-in (design.signIn = "presets"): these tokens are already published in app.json.\n  presets: ${JSON.stringify(presets)}` : ""}
});
`;
}
