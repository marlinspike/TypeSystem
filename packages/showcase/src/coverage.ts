import { COVERAGE, QUESTIONS, STAGES, SURFACES } from "./catalog.js";

/** docs/showcase/coverage.md, from the catalog: which demonstration shows each capability, and how to ask each question. */
export function coverageMarkdown(): string {
  const q = new Map(QUESTIONS.map((x) => [x.id, x]));
  const lines = [
    "# Showcase coverage",
    "",
    "Generated from `packages/showcase/src/catalog.ts` by `npm run showcase -- coverage`. A test fails when this file and the catalog disagree.",
    "",
    "## Capabilities and where each is shown",
    "",
    "| Capability | Shown by | Question |",
    "| --- | --- | --- |",
    ...COVERAGE.map((c) => `| ${c.feature} | ${c.shownBy.join("; ")} | ${c.question ? q.get(c.question)!.question : ""} |`),
    "",
    "## The ten questions",
    ""
  ];
  for (const x of QUESTIONS) {
    lines.push(`### ${x.question}`, "", x.answer, "");
    for (const l of x.links) lines.push(`- ${l.label}: ${SURFACES[l.surface].title}, \`http://127.0.0.1:${SURFACES[l.surface].port}${l.path}\``);
    for (const c of x.cli) lines.push(`- Terminal: \`${c}\``);
    for (const m of x.mcp) lines.push(`- MCP, ${m.server}: ${m.tools.map((t) => `\`${t}\``).join(", ")}`);
    lines.push(`- Implemented in: ${x.sources.map((s) => `\`${s}\``).join(", ")}`);
    if (x.limits) lines.push(`- What it does not show: ${x.limits}`);
    lines.push("");
  }
  lines.push("## Lifecycle stages of the challenge", "", "| Stage | What happens | Evidence |", "| --- | --- | --- |");
  for (const s of STAGES) lines.push(`| ${s.id}. ${s.title} | ${s.what} | \`${s.evidence}\` |`);
  lines.push("");
  return lines.join("\n");
}
