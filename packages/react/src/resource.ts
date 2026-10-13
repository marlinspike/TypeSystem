/** Where one asynchronous read or call is. */
export type ResourceState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly data?: T }
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "error"; readonly error: Error; readonly data?: T };

/**
 * One asynchronous value with subscribers, independent of React (ADR-0058):
 * the hooks are a thin `useSyncExternalStore` over it, and it can be tested,
 * or bound to another framework, on its own. Only the latest `run` settles
 * the state, so a slow earlier answer never overwrites a newer one.
 */
export class Resource<T> {
  private state: ResourceState<T> = { status: "idle" };
  private readonly listeners = new Set<() => void>();
  private latest = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ResourceState<T> => this.state;

  /** Runs `load`, keeping the last data visible while it runs. Resolves when this run settles (or is superseded). */
  async run(load: () => Promise<T>): Promise<void> {
    const ticket = ++this.latest;
    const previous = "data" in this.state ? this.state.data : undefined;
    this.set(previous === undefined ? { status: "loading" } : { status: "loading", data: previous });
    try {
      const data = await load();
      if (ticket === this.latest) this.set({ status: "success", data });
    } catch (err) {
      if (ticket === this.latest) this.set({ status: "error", error: err instanceof Error ? err : new Error(String(err)), ...(previous === undefined ? {} : { data: previous }) });
    }
  }

  /** Back to idle; any run still in flight no longer settles anything. */
  reset(): void {
    this.latest++;
    this.set({ status: "idle" });
  }

  private set(next: ResourceState<T>): void {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
}

/** The state's data, whether settled or kept visible while a newer read runs. */
export function dataOf<T>(state: ResourceState<T>): T | undefined {
  return "data" in state ? state.data : undefined;
}

/** The state's error, when its latest read or call failed. */
export function errorOf(state: ResourceState<unknown>): Error | undefined {
  return state.status === "error" ? state.error : undefined;
}
