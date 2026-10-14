import { ApiError } from "@typesys/sdk";

/** A refusal or failure as the API stated it: its code, so a person can tell "not allowed" from "not found". */
export function ErrorNote({ error }: { readonly error: unknown }) {
  if (error === null || error === undefined) return null;
  const code = error instanceof ApiError ? error.code : undefined;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "The request failed";
  return (
    <p className="error" role="alert">
      {code && <span className="badge">{code}</span>} {message}
    </p>
  );
}
