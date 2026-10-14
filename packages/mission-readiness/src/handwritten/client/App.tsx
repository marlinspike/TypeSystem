import { useCallback, useEffect, useState } from "react";
import { Problem, Shell, useToken, type SignInOption } from "../../shared/client/shell.js";

// The app's own wire types, kept in step with its server by hand.
interface BoardRow {
  id: string;
  tailNumber?: string;
  model?: string;
  readinessStatus?: string;
  deploymentLocation?: string;
}
interface WorkOrder {
  id: string;
  status?: string;
  assignedTo?: string;
  canUpdate: boolean;
}
interface MaintenanceEvent {
  id: string;
  eventType?: string;
  occurredAt?: string;
  description?: string;
  canOpen: boolean;
  workOrder?: WorkOrder;
}
interface Approval {
  id: string;
  tailNumber: string;
  proposal: { eventId: string; priority: string; rationale: string };
}
const STATUSES = ["open", "in-progress", "closed"] as const;

type Call = <T>(method: "GET" | "POST", path: string, body?: unknown) => Promise<T>;

function caller(token: string | undefined): Call {
  return async <T,>(method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetch(path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  };
}

/** Loads `path` whenever it or the caller changes. */
function useGet<T>(call: Call, path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    if (path === null) return;
    setError(null);
    call<T>("GET", path).then(setData, setError);
  }, [call, path]);
  useEffect(load, [load]);
  return { data, error, refresh: load };
}

export function App() {
  const [signIns, setSignIns] = useState<readonly SignInOption[]>([]);
  const [token, setToken] = useToken();
  const [selected, setSelected] = useState<string | null>(null);
  const [call, setCall] = useState<Call>(() => caller(token));
  useEffect(() => setCall(() => caller(token)), [token]);
  const me = useGet<{ name: string }>(call, "/app/me");

  useEffect(() => {
    void fetch("/config.json").then(async (r) => setSignIns(((await r.json()) as { signIns: SignInOption[] }).signIns));
  }, []);

  return (
    <Shell title="Squadron Readiness" signIns={signIns} token={token} onToken={setToken} who={me.data?.name ?? null}>
      <Board call={call} onOpen={setSelected} />
      {selected && <Aircraft call={call} tail={selected} />}
      <Approvals call={call} />
    </Shell>
  );
}

function Board({ call, onOpen }: { readonly call: Call; readonly onOpen: (tail: string) => void }) {
  const board = useGet<BoardRow[]>(call, "/app/board");
  return (
    <section data-testid="board">
      <h2>Aircraft needing attention</h2>
      <Problem error={board.error} />
      {board.data && (
        <table>
          <thead>
            <tr>
              <th>Tail</th>
              <th>Model</th>
              <th>Readiness</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody>
            {board.data.map((a) => (
              <tr key={a.id}>
                <td>
                  <button className="link" onClick={() => onOpen(a.id)}>
                    {a.tailNumber}
                  </button>
                </td>
                <td>{a.model}</td>
                <td>{a.readinessStatus}</td>
                <td>{a.deploymentLocation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Aircraft({ call, tail }: { readonly call: Call; readonly tail: string }) {
  const history = useGet<MaintenanceEvent[]>(call, `/app/aircraft/${encodeURIComponent(tail)}/events`);
  const [started, setStarted] = useState<{ status: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const ground = async () => {
    setError(null);
    try {
      setStarted(await call<{ status: string }>("POST", `/app/aircraft/${encodeURIComponent(tail)}/ground`, {}));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section data-testid="detail">
      <div className="row">
        <h2>{tail}</h2>
        <button onClick={() => void ground()}>Ground for repair</button>
        {started && <span data-testid="run-status">{started.status}</span>}
      </div>
      <Problem error={error ?? history.error} />
      <ul className="events" data-testid="events">
        {history.data?.map((e) => (
          <li key={e.id} data-testid={`event-${e.id}`}>
            <strong>{e.eventType}</strong> <span className="muted">{e.occurredAt?.slice(0, 10)}</span> {e.description}
            {e.workOrder ? <WorkOrderLine call={call} order={e.workOrder} onChange={history.refresh} /> : <OpenWorkOrder call={call} event={e} onDone={history.refresh} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function OpenWorkOrder({ call, event, onDone }: { readonly call: Call; readonly event: MaintenanceEvent; readonly onDone: () => void }) {
  const [problem, setProblem] = useState<unknown>(null);
  if (!event.canOpen) return <div className="muted">No work order</div>;
  const open = async () => {
    try {
      await call("POST", `/app/events/${encodeURIComponent(event.id)}/work-orders`, {});
      onDone();
    } catch (err) {
      setProblem(err);
    }
  };
  return (
    <div className="row">
      <span className="muted">No work order</span>
      <button onClick={() => void open()}>Open work order</button>
      <Problem error={problem} />
    </div>
  );
}

function WorkOrderLine({ call, order, onChange }: { readonly call: Call; readonly order: WorkOrder; readonly onChange: () => void }) {
  const [status, setStatus] = useState(order.status ?? "open");
  const [problem, setProblem] = useState<unknown>(null);
  return (
    <div className="row" data-testid={`order-${order.id}`}>
      <span className="badge">{order.id}</span>
      <span data-testid="order-status">{order.status}</span>
      <span className="muted">{order.assignedTo}</span>
      {order.canUpdate && (
        <>
          <select aria-label={`Status of ${order.id}`} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button onClick={() => void call("POST", `/app/work-orders/${encodeURIComponent(order.id)}/status`, { status }).then(onChange, setProblem)}>Set status</button>
        </>
      )}
      <Problem error={problem} />
    </div>
  );
}

function Approvals({ call }: { readonly call: Call }) {
  const pending = useGet<Approval[]>(call, "/app/approvals");
  const [done, setDone] = useState<string | null>(null);
  if (!pending.data?.length) return done ? <p data-testid="approved">{done}</p> : null;
  return (
    <section className="wide" data-testid="approvals">
      <h2>Waiting on your approval</h2>
      {pending.data.map((a) => (
        <div key={a.id} className="row">
          <strong>{a.tailNumber}</strong> {a.proposal.priority}: {a.proposal.eventId}. {a.proposal.rationale}
          <button
            className="primary"
            onClick={() =>
              void call<{ status: string }>("POST", `/app/approvals/${encodeURIComponent(a.id)}`, {}).then((run) => {
                setDone(`${a.tailNumber}: ${run.status}`);
                pending.refresh();
              })
            }
          >
            Approve
          </button>
        </div>
      ))}
    </section>
  );
}
