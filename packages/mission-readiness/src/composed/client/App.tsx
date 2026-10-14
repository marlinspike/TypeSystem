import { useEffect, useMemo, useState } from "react";
import type { AirforceModel } from "@typesys/domain-airforce";
import { createTypeSHooks, dataOf, errorOf } from "@typesys/react";
import { createClient, httpCall, httpTransport, httpWorkflows, type Row } from "@typesys/sdk";
import { Problem, Shell, useToken, type SignInOption } from "../../shared/client/shell.js";

const { TypeSProvider, useClient, useQuery, useLoad, useActions, useAction } = createTypeSHooks<AirforceModel>();
type Workflows = ReturnType<typeof httpWorkflows>;
type WorkOrder = Row<AirforceModel, "airforce.WorkOrder">;
const STATUSES: readonly NonNullable<WorkOrder["status"]>[] = ["open", "in-progress", "closed"];

/**
 * The squadron readiness application, composed from TypeS (ADR-0063): the
 * typed SDK over the governed API, the React hooks, Action previews and the
 * ground-for-repair workflow. It holds no access rule of its own: whatever
 * it shows or offers is what the runtime and the workflow engine decided
 * for the signed-in person.
 */
export function App() {
  const [signIns, setSignIns] = useState<readonly SignInOption[]>([]);
  const [token, setToken] = useToken();
  const [who, setWho] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const opts = useMemo(() => ({ baseUrl: "/api", ...(token ? { token } : {}) }), [token]);
  const client = useMemo(() => createClient<AirforceModel>(httpTransport(opts)), [opts]);
  const workflows = useMemo(() => httpWorkflows(opts), [opts]);

  useEffect(() => {
    void fetch("/config.json").then(async (r) => setSignIns(((await r.json()) as { signIns: SignInOption[] }).signIns));
  }, []);
  useEffect(() => {
    setWho(null);
    void (httpCall(opts)("GET", "/me") as Promise<{ subjectId: string }>).then((me) => setWho(me.subjectId), () => setWho(null));
  }, [opts]);

  return (
    <Shell title="Squadron Readiness" signIns={signIns} token={token} onToken={setToken} who={who}>
      <TypeSProvider client={client} key={token ?? "anonymous"}>
        <Board onOpen={setSelected} />
        {selected && <Aircraft tail={selected} workflows={workflows} />}
        <Approvals workflows={workflows} />
      </TypeSProvider>
    </Shell>
  );
}

function Board({ onOpen }: { readonly onOpen: (tail: string) => void }) {
  const board = useQuery(
    (af) => af.from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)).select("tailNumber", "model", "readinessStatus", "deploymentLocation").orderBy("tailNumber").limit(50),
    []
  );
  return (
    <section data-testid="board">
      <h2>Aircraft needing attention</h2>
      <Problem error={errorOf(board)} />
      {dataOf(board) && (
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
            {dataOf(board)?.items.map((a) => (
              <tr key={a.$id}>
                <td>
                  <button className="link" onClick={() => onOpen(a.$id)}>
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

function Aircraft({ tail, workflows }: { readonly tail: string; readonly workflows: Workflows }) {
  const history = useLoad((af) => af.from("airforce.MaintenanceEvent").where((e) => e.aircraftId.eq(tail)).include("workOrder").orderBy("occurredAt", "desc").page(), [tail]);
  const [started, setStarted] = useState<{ status: string; reason?: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const ground = async () => {
    setError(null);
    try {
      setStarted(await workflows.start("airforce.GroundForRepair", { aircraftId: tail, assignTo: "SSgt Rivera" }));
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
      <Problem error={error ?? errorOf(history)} />
      <ul className="events" data-testid="events">
        {dataOf(history)?.items.map((e) => (
          <li key={e.$id} data-testid={`event-${e.$id}`}>
            <strong>{e.eventType}</strong> <span className="muted">{e.occurredAt?.slice(0, 10)}</span> {e.description}
            {e.workOrder[0] ? <WorkOrderLine order={e.workOrder[0]} onChange={history.refresh} /> : <OpenWorkOrder eventId={e.$id} onDone={history.refresh} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function OpenWorkOrder({ eventId, onDone }: { readonly eventId: string; readonly onDone: () => void }) {
  const client = useClient();
  const actions = useActions("airforce.MaintenanceEvent", eventId);
  const [problem, setProblem] = useState<unknown>(null);
  if (!dataOf(actions)?.some((a) => a.name === "CreateMaintenanceWorkOrder" && a.authorized)) return <div className="muted">No work order</div>;
  const open = async () => {
    const create = client.action("CreateMaintenanceWorkOrder");
    const input = { maintenanceEventId: eventId, assignedTo: "SSgt Rivera" };
    try {
      // Decided as the invocation would be, with nothing executed (ADR-0053); invoked only if it would run.
      const preview = await create.preview(input);
      if (!preview.wouldExecute) return setProblem(preview.blockers.map((b) => b.message).join("; "));
      await create.invoke(input);
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

function WorkOrderLine({ order, onChange }: { readonly order: WorkOrder; readonly onChange: () => void }) {
  const actions = useActions("airforce.WorkOrder", order.$id);
  const update = useAction("UpdateWorkOrderStatus");
  const [status, setStatus] = useState(order.status ?? "open");
  const allowed = dataOf(actions)?.some((a) => a.name === "UpdateWorkOrderStatus" && a.authorized) === true;
  return (
    <div className="row" data-testid={`order-${order.$id}`}>
      <span className="badge">{order.$id}</span>
      <span data-testid="order-status">{order.status}</span>
      <span className="muted">{order.assignedTo}</span>
      {allowed && (
        <>
          <select aria-label={`Status of ${order.$id}`} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button onClick={() => void update.invoke({ workOrderId: order.$id, status }).then(onChange)}>Set status</button>
        </>
      )}
      <Problem error={errorOf(update.invoked)} />
    </div>
  );
}

function Approvals({ workflows }: { readonly workflows: Workflows }) {
  const pending = useLoad(() => workflows.approvals(), [workflows]);
  const [done, setDone] = useState<string | null>(null);
  const waiting = dataOf(pending) ?? [];
  if (!waiting.length) return done ? <p data-testid="approved">{done}</p> : null;
  return (
    <section className="wide" data-testid="approvals">
      <h2>Waiting on your approval</h2>
      {waiting.map((a) => {
        const p = a.presented as { tailNumber?: string; proposal?: { eventId: string; priority: string; rationale: string } };
        return (
          <div key={a.runId} className="row">
            <strong>{p.tailNumber}</strong> {p.proposal?.priority}: {p.proposal?.eventId}. {p.proposal?.rationale}
            <button
              className="primary"
              onClick={() =>
                void workflows.approve(a.runId, a.step, { approved: true }).then((run) => {
                  setDone(`${p.tailNumber}: ${run.status}`);
                  pending.refresh();
                })
              }
            >
              Approve
            </button>
          </div>
        );
      })}
    </section>
  );
}
