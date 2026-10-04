---
name: eval
description: Run a held-out twin evaluation, review its report, and resume interrupted runs.
user-invocable: true
---

# Eval

For engine commands, the plugin root is `${CLAUDE_PLUGIN_ROOT}`, or two directories above this file. Use the selected persona consistently through `BUNSHIN_PERSONA` or `--persona <dir>`; otherwise the engine selects the only persona in `BUNSHIN_HOME`. Talk to the user in the user's language. Never write a persona file yourself; the CLI owns every write. Never post or send anything.

Read `$ARGUMENTS` for options the user named. Run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" eval run
```

Pass only the user's named `--judge <spec>`, `--drafter <spec>`, and `--limit <n>` options, plus `--persona <dir>` when the selected persona uses that flag. Do not pass `--run` on a fresh run.

If the CLI exits 1 with `rerun with --run <run_id> to resume`, show its error as-is and offer to resume. Never start a new run silently after a host error. If the owner agrees, run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" eval run --run <run_id>
```

Append the same named options and persona flag from the interrupted invocation. For any other non-zero exit, show the CLI error as-is and stop.

The successful `eval run` output already includes `report.md`; present its Markdown as-is without editing or summarizing it. For a separate report view, run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" eval report
```

Append `--run <run_id>` or `--persona <dir>` only when needed. After a successful report, use one sentence that repeats only the overall status word shown there—`MET`, `NOT MET`, or `sample too small`. If it says `sample too small` and the report shows an `incomplete:` line, say to run `eval run` without `--limit` (or resume with `--run <run_id>`). Otherwise, if it shows a `launch bar basis: … ratings` line, say to run `/bunshin:calibrate`. Otherwise, say that more held-out pairs are needed. Never restate a launch-bar result that the report does not show, and never calculate or infer rates yourself. Do not add or paraphrase judge reasons beyond what the CLI output shows.
