import path from "node:path";
import { realpathSync } from "node:fs";

const escapes = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

/** The real path of `p`: symlinks followed as far as the path exists, the rest appended as written. */
function realOf(p: string): string {
  const rest: string[] = [];
  let at = p;
  for (;;) {
    try {
      return path.join(realpathSync(at), ...rest.reverse());
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return p;
      rest.push(path.basename(at));
      at = parent;
    }
  }
}

/**
 * `p` inside `root`, or an error: an agent's path never leaves the tree the
 * server was started on, by `..` or by a symlink it leads through.
 */
export function insideRoot(root: string, p: unknown): string {
  if (typeof p !== "string" || p === "") throw new Error("a path is required");
  const abs = path.resolve(root, p);
  if (escapes(path.relative(path.resolve(root), abs)) || escapes(path.relative(realOf(path.resolve(root)), realOf(abs)))) throw new Error(`${p} is outside the server's root`);
  return abs;
}

