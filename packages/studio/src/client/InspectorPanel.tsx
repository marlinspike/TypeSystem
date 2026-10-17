import type { MemberInspection, ModelInspection } from "@typesys/core";
import type { GraphNode } from "@typesys/devkit";
import type { GraphReach } from "./api.js";

function Markings({ m }: { readonly m: { readonly markings: readonly string[]; readonly withheldMarkings?: number } }) {
  return (
    <>
      {m.markings.map((x) => (
        <span key={x} className="badge marking">
          {x}
        </span>
      ))}
      {m.withheldMarkings ? <span className="badge">+{m.withheldMarkings} you are not cleared to name</span> : null}
    </>
  );
}

function rule(inspection: ModelInspection, policy: string | undefined) {
  const p = policy ? inspection.policies.find((x) => x.name === policy) : undefined;
  return p ? (p.rule ?? "opaque rule") : undefined;
}

function MemberRow({ m, inspection }: { readonly m: MemberInspection; readonly inspection: ModelInspection }) {
  return (
    <tr>
      <td>
        <code>{m.name}</code>
        {m.origin.from !== "own" && <div className="muted">from {m.origin.from === "trait" ? `trait ${m.origin.name}` : m.origin.type}</div>}
      </td>
      <td>
        {m.computed ? (
          <>
            computed from {m.computed.dependsOn.join(", ") || "nothing"}
            {m.computed.releases.length > 0 && <div className="muted">released from {m.computed.releases.join(", ")}</div>}
            <div className="muted">reads {m.computed.reads === "undeclared" ? "undeclared sources" : m.computed.reads.join(", ") || "no source"}</div>
          </>
        ) : (
          m.source && (
            <>
              {m.source.dataSourceId}
              <div className="muted">
                {m.source.operation}
                {m.source.override ? ", own mapping" : ""}
              </div>
            </>
          )
        )}
      </td>
      <td>
        {m.policy ? (
          <>
            <code>{m.policy}</code>
            <div className="muted">{rule(inspection, m.policy)}</div>
          </>
        ) : (
          <span className="muted">object policy</span>
        )}
      </td>
      <td>
        <Markings m={m} />
      </td>
    </tr>
  );
}

/**
 * What the selected node is and what guards it: for a Type, every value's
 * source, policy with its rule, markings and derivation, from the
 * inspection when the caller may inspect. Then what depends on it and what
 * it rests on, each with the path that connects them.
 */
export function InspectorPanel(props: {
  readonly node: GraphNode | null;
  readonly inspection: ModelInspection | null;
  readonly reach: GraphReach | null;
  readonly onWalk: (direction: "dependents" | "dependencies") => void;
  readonly onClear: () => void;
  readonly onOpen: (id: string) => void;
  readonly onExplain: (node: GraphNode) => void;
}) {
  const { node, inspection, reach } = props;
  if (!node) return <aside className="inspector muted">Select a node to see what guards it and what depends on it.</aside>;
  const type = inspection?.types.find((t) => `type:${t.name}` === node.id || `type:${t.name}` === node.parent);
  const member = node.kind === "member" ? type?.members.find((m) => m.name === node.label) : undefined;
  const members = member ? [member] : node.kind === "type" ? (type?.members ?? []) : [];
  const relationship = node.kind === "relationship" ? type?.relationships.find((r) => r.name === node.label) : undefined;
  const explainable = ["type", "member", "relationship", "action", "workflow"].includes(node.kind) && !node.unresolved;
  return (
    <aside className="inspector" data-testid="inspector">
      <div className="row">
        <span className="badge">{node.kind}</span>
        <h3>{node.label}</h3>
      </div>
      {node.unresolved && <p className="warn">A consumer uses this, and the model does not describe it to you: it does not exist, or you may not learn of it.</p>}
      {node.detail?.opaque !== undefined && <p className="warn">{String(node.detail.opaque)}</p>}
      {node.detail && (
        <p className="muted">
          {Object.entries(node.detail)
            .filter(([k]) => k !== "opaque")
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
            .join(" · ")}
        </p>
      )}
      {type && node.kind === "type" && (
        <p>
          Object policy <code>{type.objectPolicy}</code> <span className="muted">{rule(inspection!, type.objectPolicy)}</span>
          {type.source && (
            <>
              {" "}
              · values from <strong>{type.source.dataSourceId}</strong>
            </>
          )}{" "}
          <Markings m={type} />
        </p>
      )}
      {inspection && members.length > 0 && (
        <div className="scroll">
          <table data-testid="guards">
            <thead>
              <tr>
                <th>Value</th>
                <th>Comes from</th>
                <th>Read policy</th>
                <th>Markings</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow key={m.name} m={m} inspection={inspection} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {relationship && inspection && (
        <p>
          To <code>{relationship.target}</code> ({relationship.cardinality}
          {relationship.optional ? ", optional" : ""}) through <strong>{relationship.source.dataSourceId}</strong>
          {relationship.crossSource && <span className="badge">crosses sources</span>}
          {relationship.policy && (
            <>
              {" "}
              · policy <code>{relationship.policy}</code> <span className="muted">{rule(inspection, relationship.policy)}</span>
            </>
          )}
        </p>
      )}
      <div className="row">
        <button onClick={() => props.onWalk("dependents")}>What depends on it</button>
        <button onClick={() => props.onWalk("dependencies")}>What it rests on</button>
        <button onClick={() => props.onOpen(node.id)}>Open neighborhood</button>
        {explainable && <button onClick={() => props.onExplain(node)}>Explain access</button>}
      </div>
      {reach && reach.subject === node.id && (
        <div data-testid="reach">
          <div className="row">
            <strong>
              {reach.reached.length} reached
              {reach.consumers.length > 0 && <>, in {reach.consumers.join(", ")}</>}
            </strong>
            <button className="link" onClick={props.onClear}>
              clear
            </button>
          </div>
          {reach.opaque.length > 0 && <p className="warn">{reach.opaque.length} reached step(s) read through code that declares nothing, so this may be incomplete.</p>}
          <ul className="list reach">
            {reach.reached.slice(0, 200).map((r) => (
              <li key={r.id}>
                <button title={r.path.join(" → ")} onClick={() => props.onOpen(r.id)}>
                  <span className="badge">{r.kind}</span> {r.label} <span className="muted">{r.via}{r.how ? ` (${r.how})` : ""}, {r.distance} hop{r.distance === 1 ? "" : "s"}{r.basis === "inferred" ? ", inferred" : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
