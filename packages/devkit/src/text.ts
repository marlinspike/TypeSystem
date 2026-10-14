/** Words that carry no meaning about a model: a task's "which ... in the ..." matches nothing by them. */
const STOP_WORDS = new Set(
  "a an and are as at be by can do does for from has have how i in is it its me my of on or our show that the their them this to was what when where which who why will with".split(" ")
);

/** Lowercase word tokens: `needsAttention` → needs, attention; `airforce.WorkOrder` → airforce, work, order. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);
}

/** A deliberately small stemmer (plural and verb endings, a final e), enough for "orders" to find "order" and "close" to find "closed" without a dependency. */
function stem(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith("ies")) t = `${t.slice(0, -3)}y`;
  else if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t.length > 4 && t.endsWith("e") ? t.slice(0, -1) : t;
}

export function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * The closest candidate, if it is close enough to be the intended name:
 * within a third of its length in edits (qualified or not), or one it
 * abbreviates (`partNum` for `partNumber`).
 */
export function didYouMean(name: string, candidates: Iterable<string>): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const unqualified = candidate.slice(candidate.lastIndexOf(".") + 1);
    const edits = Math.min(levenshtein(name, candidate), levenshtein(name, unqualified));
    const close = edits <= Math.max(1, Math.floor(name.length / 3)) || (name.length >= 3 && unqualified.toLowerCase().startsWith(name.toLowerCase()));
    if (close && (!best || edits < best.distance)) best = { candidate, distance: edits };
  }
  return best?.candidate;
}
