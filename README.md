# Bunshin

## What it is

Bunshin is a zero-dependency Node.js CLI and Claude Code plugin for building, testing and exporting a persona of yourself from your work. The twin answers product specification questions with sources and discusses ideas using your evidenced priorities. Held-out examples measure fidelity; your own ratings calibrate the automated judge.

## Install

In Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add ryoochi0112/bunshin
/plugin install bunshin
```

The CLI needs Node.js. The sample walkthrough below runs from a clone of this repository.

## Codex

Build, eval, shadow with pasted text and export also support Codex using the same private persona directory.
See [docs/codex.md](docs/codex.md) for local plugin installation, supported commands and the online acceptance run.

## Privacy boundary

Persona data lives only in `~/bunshin-personas/<name>`, never in the repo.
The repo's `.gitignore` and a test guard this privacy boundary.
Commands refuse to write persona data into a git repo with a public remote, and refuse when the remote's privacy cannot be verified.
Set `BUNSHIN_HOME` to choose another private home outside the repo; select a persona with `BUNSHIN_PERSONA` or `--persona <dir>` when you have more than one.

bunshin never posts or sends anything.
The repo's `sample/persona/` is synthetic test data. Exports are scanned for colleague text and held-out answers before being written.

## 5-minute sample path

Clone the repo and run from its root so the fake-host fixtures are available:

```sh
git clone https://github.com/ryoochi0112/bunshin && cd bunshin
```

Persona data goes to `~/bunshin-personas/sample` (or `$BUNSHIN_HOME/sample` when configured).
The fake host needs no model or connector.

<!-- sample-path -->
```sh
node bin/bunshin.js init --sample
node bin/bunshin.js eval run --drafter fake:test/fixtures/hosts/eval-drafts.json --judge fake:test/fixtures/hosts/judge-replies.json
node bin/bunshin.js eval report
```

The sample report says "sample too small" because the sample has 3 held-out pairs.
Two judge replies are deliberately invalid, counted as `judge_error` and excluded from rates.
The report has this shape (synthetic; the date varies):

```text
held-out: 3 pairs (knowledge 1, judgment 2)
judge agreement with Sora Aoki: not calibrated → uncalibrated
drafter: fake fake · judge: fake fake
judge examples: none · 3-call vote
judge errors: 2 (excluded from rates)
```

A real launch-bar claim needs about 100 pairs (at least 34 per layer at the default 0.3 held-out ratio).

## Your own persona

From the repo root, create your private persona with `node bin/bunshin.js init <name>`. Set `owner.slack_user_id` in its private `persona.json` to your exact Slack user id before harvesting. Select that persona consistently in Claude Code.

1. `/bunshin:harvest` — choose channels and a date range; collect owner-answered pairs and create a stable build/held-out split.
2. `/bunshin:interview` — answer one evidence-grounded question at a time, up to 15 per session.
3. `/bunshin:diagnose` — resolve conflicts between observed behaviour and interview answers.
4. `/bunshin:build` — start a fresh session after harvest, then commit an identity from build-set evidence only.
5. `/bunshin:examples` — optional: rate 12 build-split drafts so the judge is anchored to your ratings; doing it before eval lets calibrate rate the anchored judge.
6. `/bunshin:eval` — draft held-out answers, judge them and print a dated report. Use `--limit <n>` for a smaller run or `--judge <spec>` to select the judge.
7. `/bunshin:calibrate` — rate about 30 drafts without seeing judge ratings; review judge agreement. Below 80% agreement, judge scores are untrusted and only your ratings count for the launch bar.
8. `/bunshin:export` — write a standalone package; load the printed package path with `claude --plugin-dir <path>` in a fresh session.

Harvest needs the Slack connector and runs on Claude Code only.
Spec answers need the Notion connector for live sources, otherwise the twin says it does not know.

Use `/bunshin:spec-answer` for product questions, `/bunshin:idea-discussion` for ideas, and `/bunshin:shadow` for a private draft and comparison with your real answer. The twin responds in the question's language.

## Formats

See [docs/formats.md](docs/formats.md) for the plain-file persona, identity, case and report formats. See [docs/hosts.md](docs/hosts.md) for host isolation and tool permissions.

### Knowledge bases

A knowledge base holds reviewed, citable product facts, kept under `$BUNSHIN_HOME/kb/<name>` and managed with `bunshin kb`. See [docs/kb-format.md](docs/kb-format.md) for the layout, entry grammar, statuses, scrub list and citation syntax. A synthetic demo is at `sample/kb/demo`. Bind a knowledge base to a persona with `bunshin persona kb <name>` (which sets the optional `kb` field in `persona.json`), and spec answers then cite only its verified entries. `bunshin persona kb` shows the binding and `bunshin persona kb --unset` removes it. Run `/bunshin:kb-compile` to turn one Notion page, Slack thread or pasted text into draft entries that the owner approves. Run `/bunshin:kb-ssot` to restate the verified entries as a compiled SSOT (see below).

### Compile an SSOT

An SSOT is one reviewed document that the drafter reads and cites instead of the flat entry list. Entries stay the reviewed store, and every SSOT statement names the entries that back it. The sample knowledge base stays in `entries` mode.

- Run `/bunshin:kb-ssot <kb>`. Claude drafts sections from the verified entries and saves them with `kb ssot draft`. It never approves or enables.
- Review the sections with `kb ssot status <kb>` and `kb ssot show <kb> <section>`, and run `kb check <kb>`.
- Approve each section you accept: `node bin/bunshin.js kb ssot approve <kb> <section>`.
- Switch the digest: `node bin/bunshin.js kb ssot enable <kb>`. Run `kb ssot disable <kb>` to go back to entries.
- Import the coverage labels again with `coverage import`. Enabling changes the digest hash, so `coverage.json` is `coverage_stale` until you do.

In `ssot` mode, citing an entry id fails gate 3 with `not-citable`. If no section remains approved, `kb check` reports `ssot-empty`, binding refuses the knowledge base, and shadow, spec answers and `eval run` stop. Recover with `kb ssot approve` or switch back with `kb ssot disable`.

See [docs/kb-format.md](docs/kb-format.md) for the file formats, section states, `kb check` findings and the one thanks line that needs no citation.

### Measuring knowledge base answers

With a bound knowledge base, `eval run` records each spec answer's shape and the check of every cited sentence by a support judge. `eval report` then grades them against your coverage labels. Labels say, for each held-out case, whether the knowledge base covers the question fully (`C`), in part (`P`), not at all (`N`) or should be excluded (`X`). See [docs/formats.md](docs/formats.md) for `coverage.json`, `support.jsonl` and the `kb_gates` section.

```sh
node bin/bunshin.js coverage import <file> [--persona <dir>]
node bin/bunshin.js coverage show [--persona <dir>]
node bin/bunshin.js eval report --runs <run_a>,<run_b>[,…] [--persona <dir>]
```

`coverage import` reads a JSON file with a `cases` array of `{id, coverage, entries}` rows, checks it against the held-out pairs and the bound knowledge base, and writes `coverage.json` in the persona directory. In both digest modes, `entries` keeps entry ids and accepts only verified, unflagged, unique entries; `kb_digest_hash` records the active mode's digest hash. It prints `Imported <n> labels (C <a> · P <b> · N <c> · X <d>) for kb <name>`. A bad row refuses the whole import and names the row. `coverage show` prints the counts and the knowledge base digest, and `stale` when the knowledge base changed after the import.

`eval report --runs` compares two or more runs that share the same knowledge base, persona version, drafter, judge, rubrics, judge examples, coverage file and cases. It writes `evals/reliability/<a>+<b>+….json` and `.md`, and marks each case `stable_pass`, `stable_fail`, `unstable` or `incomplete`. Runs that differ in any of those inputs are refused.

`make harness` checks the support judge itself on built-in synthetic sentence and entry pairs: a supporting entry must give `supported` and a non-supporting one must not, and a short and a long supporting entry must both give `supported`. It runs `node scripts/harness.js --host claude`, so it makes real model calls and needs an authenticated Claude Code CLI. It is manual and is not part of `make verify`.

## Status

M2: Claude Code path covers criteria 1–14: harvest, held-out split, build, interview, diagnose, spec answers, idea discussion, shadow, eval, calibration, launch-bar checks, export, privacy and open formats.
Codex host support is planned for M3.
The Codex adapter and plugin are implemented; online Codex acceptance must pass before claiming the M3 path is accepted.

Run `make verify` for offline syntax and tests. Run `make acceptance` separately for six online checks with the real Claude host and a temporary sample persona; it requires a working, authenticated Claude Code CLI. Online acceptance must pass before claiming the M2 path is accepted.

MIT. See [LICENSE](LICENSE).
