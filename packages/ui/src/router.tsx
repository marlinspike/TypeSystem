import { toText } from "./format.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";

/** One page of the application, as the compiler lists them. */
export interface PageRoute {
  readonly name: string;
  readonly title: string;
  /** `/`, `/shipments/:id`. */
  readonly path: string;
  /** Listed in navigation. */
  readonly nav: boolean;
  /** Callers it is listed for (by `/me` roles is not knowable here, so by caller name); empty: everyone. */
  readonly for?: readonly string[];
  readonly component: ComponentType<{ readonly params: Readonly<Record<string, string>> }>;
}

export interface Route {
  readonly page: PageRoute | undefined;
  readonly params: Readonly<Record<string, string>>;
  readonly path: string;
}

interface RouterValue extends Route {
  readonly pages: readonly PageRoute[];
  navigate(page: string, params?: Readonly<Record<string, unknown>>): void;
  href(page: string, params?: Readonly<Record<string, unknown>>): string;
}

const RouterContext = createContext<RouterValue | null>(null);

export function useRouter(): RouterValue {
  const r = useContext(RouterContext);
  if (!r) throw new Error("useRouter outside <Router>");
  return r;
}

/** `/shipments/:id` against `/shipments/S-1` → `{ id: "S-1" }`, or undefined. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, seg] of p.entries()) {
    const got = s[i]!;
    if (seg.startsWith(":")) {
      try {
        params[seg.slice(1)] = decodeURIComponent(got);
      } catch {
        return undefined;
      }
    } else if (seg !== got) return undefined;
  }
  return params;
}

/** A page's path with its parameters filled in, each encoded. */
export function fillPath(pattern: string, params: Readonly<Record<string, unknown>> = {}): string {
  return (
    "/" +
    pattern
      .split("/")
      .filter(Boolean)
      .map((seg) => (seg.startsWith(":") ? encodeURIComponent(toText(params[seg.slice(1)]) ?? "") : seg))
      .join("/")
  );
}

function resolve(pages: readonly PageRoute[], path: string): Route {
  for (const page of pages) {
    const params = matchPath(page.path, path);
    if (params) return { page, params, path };
  }
  return { page: undefined, params: {}, path };
}

/** The application's routes over the History API: a deep link or a reload lands on its page (the server answers with index.html). */
export function Router(props: { readonly pages: readonly PageRoute[]; readonly children?: ReactNode }) {
  const [path, setPath] = useState(() => (typeof location === "undefined" ? "/" : location.pathname));
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const href = useCallback(
    (name: string, params?: Readonly<Record<string, unknown>>) => {
      const page = props.pages.find((p) => p.name === name);
      return page ? fillPath(page.path, params) : "/";
    },
    [props.pages]
  );
  const navigate = useCallback(
    (name: string, params?: Readonly<Record<string, unknown>>) => {
      const to = href(name, params);
      if (to !== location.pathname) history.pushState(null, "", to);
      setPath(to);
      scrollTo({ top: 0 });
    },
    [href]
  );
  const value = useMemo<RouterValue>(() => ({ ...resolve(props.pages, path), pages: props.pages, navigate, href }), [props.pages, path, navigate, href]);
  return <RouterContext.Provider value={value}>{props.children}</RouterContext.Provider>;
}

/** A link to a page that navigates in place. */
export function PageLink(props: { readonly page: string; readonly params?: Readonly<Record<string, unknown>>; readonly className?: string; readonly children?: ReactNode }) {
  const router = useRouter();
  const to = router.href(props.page, props.params);
  return (
    <a
      href={to}
      className={props.className}
      aria-current={router.path === to ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        router.navigate(props.page, props.params);
      }}
    >
      {props.children}
    </a>
  );
}
