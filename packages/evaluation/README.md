# @typesys/evaluation (private)

The three-arm productivity evaluation of milestone M6
([ADR-0073](../../docs/adr/0073-the-evaluation-is-decided-by-hidden-checks.md)).

- `tasks/` holds the application contract and each task's requirement:
  the text every arm is given, word for word.
- `hidden/` holds each task's acceptance checks, written independently of
  any solution. No arm sees them.
- `references/` holds a mission spec per task. The harness test scaffolds
  each one to show its checks can be passed.
- `results/` holds one JSON record per run, and `REPORT.md`.

```sh
npm run evaluate -- sandbox --task requisition-expedite --arm agent-without
npm run evaluate -- score --task requisition-expedite --arm conventional --dir ./my-app --source person --producer "A. Developer"
npm run evaluate -- agent --task requisition-expedite --arm agent-with --model claude-sonnet-5-5 --budget 25 --allow-spend
npm run evaluate -- report
```

`agent` runs Claude Code headless and spends money. It refuses to start
without `--allow-spend`, and `--budget` caps each run.
