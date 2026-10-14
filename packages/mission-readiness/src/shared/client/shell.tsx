import { useState, type ReactNode } from "react";

/** Shared by both versions of the mission application, and not counted in either: the page frame and sign-in. */
export interface SignInOption {
  readonly label: string;
  readonly token: string;
}

const KEY = "mission.token";

export function storedToken(): string | undefined {
  try {
    return sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function useToken(): [string | undefined, (token: string | undefined) => void] {
  const [token, setToken] = useState<string | undefined>(storedToken);
  return [
    token,
    (next) => {
      try {
        if (next) sessionStorage.setItem(KEY, next);
        else sessionStorage.removeItem(KEY);
      } catch {
        // Storage blocked: the token lives as long as the page.
      }
      setToken(next);
    }
  ];
}

export function Shell(props: {
  readonly title: string;
  readonly signIns: readonly SignInOption[];
  readonly token: string | undefined;
  readonly onToken: (token: string | undefined) => void;
  readonly who: string | null;
  readonly children?: ReactNode;
}) {
  return (
    <div className="mission">
      <header>
        <h1>{props.title}</h1>
        <span className="who">
          {props.who ? (
            <>
              Signed in as <strong data-testid="subject">{props.who}</strong>
            </>
          ) : (
            <span className="muted">Not signed in</span>
          )}
        </span>
        <nav className="signin">
          {props.signIns.map((s) => (
            <button key={s.token} className={props.token === s.token ? "on" : ""} onClick={() => props.onToken(s.token)}>
              {s.label}
            </button>
          ))}
          <button className={props.token === undefined ? "on" : ""} onClick={() => props.onToken(undefined)}>
            Sign out
          </button>
        </nav>
      </header>
      <main>{props.children}</main>
    </div>
  );
}

export function Problem({ error }: { readonly error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p className="error" role="alert">
      {error instanceof Error ? error.message : typeof error === "string" ? error : "The request failed"}
    </p>
  );
}
