import { useEffect, useMemo, useState } from "react";
import type { ModelDescription } from "@typesys/core";
import { columnsFor } from "@typesys/react";
import type { DiscoveryMatch, StudioApi } from "./api.js";
import { ErrorNote } from "./ErrorNote.js";

/**
 * The model as the API describes it (ADR-0056): Types with their composed
 * values, relationships and Actions, and discovery by task. The description
 * is the contract, the same for every caller; who may read a value is shown
 * by running a query, not here.
 */
export function ModelView(props: {
  readonly api: StudioApi;
  readonly model: ModelDescription;
  readonly onQuery: (type: string) => void;
  readonly onAction: (name: string) => void;
  readonly onGraph: (type: string) => void;
  /** The Type to open first, from a link; the first Type when it is not in the model. */
  readonly initialType?: string;
}) {
  const { api, model } = props;
  const [selected, setSelected] = useState(model.types.some((t) => t.name === props.initialType) ? props.initialType! : (model.types[0]?.name ?? ""));
  const [filter, setFilter] = useState("");
  const [task, setTask] = useState("");
  const [matches, setMatches] = useState<readonly DiscoveryMatch[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const type = model.types.find((t) => t.name === selected);
  const columns = useMemo(() => (type ? columnsFor(type) : []), [type]);
  const visible = model.types.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));

  useEffect(() => {
    if (task.trim() === "") {
      setMatches(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api.discover(task).then(
        (m) => live && (setMatches(m), setError(null)),
        (err: unknown) => live && setError(err)
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, task]);

  return (
    <div className="split">
      <aside>
        <input type="search" placeholder="Filter Types" aria-label="Filter Types" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ul className="list" data-testid="types">
          {visible.map((t) => (
            <li key={t.name}>
              <button className={t.name === selected ? "on" : ""} onClick={() => setSelected(t.name)}>
                {t.name}
                {t.deprecated && <span className="badge warn">deprecated</span>}
              </button>
            </li>
          ))}
        </ul>
        <h3>Find by task</h3>
        <input type="search" placeholder="e.g. aircraft that need attention" aria-label="Describe a task" value={task} onChange={(e) => setTask(e.target.value)} />
        <ErrorNote error={error} />
        {matches && (
          <ul className="list" data-testid="discovery">
            {matches.length === 0 && <li className="muted">Nothing in the model matches.</li>}
            {matches.map((m) => (
              <li key={`${m.kind}:${m.name}`}>
                <button title={m.summary} onClick={() => (m.kind === "type" ? setSelected(m.name) : props.onAction(m.name))}>
                  <span className="badge">{m.kind}</span> {m.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      {type && (
        <section data-testid="type">
          <div className="row">
            <h2>{type.name}</h2>
            <span className="muted">v{type.version}</span>
            <button onClick={() => props.onQuery(type.name)}>Query this Type</button>
            <button onClick={() => props.onGraph(type.name)}>Open in the graph</button>
          </div>
          {type.description && <p>{type.description}</p>}
          {type.extends && (
            <p>
              Extends{" "}
              <button className="link" onClick={() => setSelected(type.extends!)}>
                {type.extends}
              </button>
              {type.traits.length > 0 && <> with {type.traits.join(", ")}</>}
            </p>
          )}
          {type.deprecated && (
            <p className="warn">
              Deprecated since {type.deprecated.since}
              {type.deprecated.supersededBy && <>; use {type.deprecated.supersededBy}</>}
            </p>
          )}
          <h3>Values</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => (
                <tr key={c.key}>
                  <td>
                    <code>{c.key}</code>
                  </td>
                  <td>{c.options ? c.options.map(String).join(" | ") : c.kind}</td>
                  <td>
                    {c.computed && <span className="badge">computed from {type.computed.find((x) => x.name === c.key)?.dependsOn.join(", ")}</span>}
                    {type.required.includes(c.key) && <span className="badge">required</span>}
                    {!c.sortable && !c.computed && <span className="badge">not sortable</span>}
                    {c.description && <span className="muted"> {c.description}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {type.relationships.length > 0 && (
            <>
              <h3>Relationships</h3>
              <ul className="inline">
                {type.relationships.map((r) => (
                  <li key={r.name}>
                    <code>{r.name}</code> → {" "}
                    <button className="link" onClick={() => setSelected(r.target)}>
                      {r.target}
                    </button>{" "}
                    <span className="muted">({r.cardinality})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {type.actions.length > 0 && (
            <>
              <h3>Actions</h3>
              <ul className="inline">
                {type.actions.map((a) => (
                  <li key={a}>
                    <button className="link" onClick={() => props.onAction(a)}>
                      {a}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
