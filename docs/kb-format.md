# Knowledge base format

A knowledge base (KB) holds reviewed, citable facts about one product. It is separate from a persona: the persona decides tone, the KB decides facts.

A KB lives at `$BUNSHIN_HOME/kb/<name>`. Its content never belongs in this repository. The repository ships only the synthetic sample KB `sample/kb/demo`, which describes the fictional product Cloudberry Lantern. Create it with `bunshin kb init demo --sample`.

## Layout

| Path | Contents |
| --- | --- |
| `kb.json` | Manifest: `format_version` 1, `name`, `product`, `synthetic`, `languages`, and the optional `digest` (see SSOT digest). |
| `entries/<topic>.md` | One file per topic. Entries are `### <id>` blocks. |
| `sources.jsonl` | Provenance registry, one row per source document. |
| `answers.jsonl` | Extraction log: which source row produced which answer, mapped to which entry. |
| `flags.jsonl` | Freshness and conflict flags. Append-only. |
| `ssot.md` | Optional compiled SSOT: sections of statements backed by entries. |
| `ssot-approvals.jsonl` | Optional per-section approval rows for the SSOT. |
| `README.md` | Generated index: topics and entry counts by status. |

The sample KB ships only `kb.json`, `entries/` and `sources.jsonl`, and stays in `entries` mode.

The scrub list is a separate file, `$BUNSHIN_HOME/kb/<name>.scrub.txt`. It sits outside the KB directory.

## Entry grammar

Each entry starts with a `### <id>` line, followed by `key: value` lines.

```text
### demo.model.provider
claim: Cloudberry Lantern は架空のモデル「灯り」を利用する。
status: verified
verified: 2026-10-12
sources: S01#E11, S02#model
select: 利用AI=灯り; 提供元国=架空国
note: サンプルの承認済み項目。
```

The id is `<kb>.<topic>.<slug>` in lowercase ASCII. It is stable: retire an entry, never rename it. A full-line `# text` ends the entry, so do not use it as a comment.

### Entry keys

| Key | Meaning |
| --- | --- |
| `claim` | The citable fact. One statement, neutral about who asked. |
| `status` | One of the statuses below. |
| `verified` | Review date. Required when the status is `verified`. |
| `sources` | References such as `S01#E11` into `sources.jsonl`. At least one. |
| `select` | Optional short answers for select-type questions: `key=value; key=value`. |
| `note` | Optional one-line note for reviewers. Never quoted in answers. |

Any other key is a grammar error.

### Statuses

| Status | Meaning |
| --- | --- |
| `draft` | Proposed, not yet reviewed. Not citable. |
| `verified` | Reviewed by the owner. The only citable status. |
| `conflict` | Sources disagree. Not citable until resolved. |
| `retired` | No longer true. Not citable. |

`bunshin kb approve <name> <id>` marks an entry verified. Use `--resolve` for a `conflict` entry.

## Scrub list

`<name>.scrub.txt` has one string per line: client names and client-side people. `bunshin kb check` reports any entry, label or file name that contains one. Findings never print the scrubbed string.

## Citations

A cited sentence ends with the entry id in brackets, for example:

```text
Cloudberry Lantern は架空のモデル「灯り」を利用します。[demo.model.provider]
```

Only `verified`, unflagged entries are citable. In `ssot` mode the citable ids are the statements of approved SSOT sections instead (see SSOT digest). When no entry covers the question, the answer abstains and names the nearest topic:

```text
該当する情報がありません。
Closest topic: model

Not covered.
Closest topic: model
```

## Binding a persona

A persona uses a KB when its `persona.json` has the optional field `"kb": "demo"`. The value must match `/^[a-z0-9][a-z0-9-]*$/`; any other type or form makes the manifest invalid. Without the field the persona is unbound and its prompts and drafts are unchanged. Set the field with `bunshin persona kb <name>`; it refuses a KB that is missing, has parse errors or fails `kb check`, and then leaves `persona.json` unchanged. `bunshin persona kb --unset` removes the field, and `bunshin persona kb` prints the bound name or `unbound`.

For a bound persona, the `spec-answer` prompt switches to the KB template. The template tells the model to cite only the digest, so the model needs no tools. If the KB is missing, has parse errors or fails `kb check`, `twin prompt`, `shadow draft` and `eval run` exit 1 with `KB <name> not found`, `KB <name> has parse errors: <file>:<line> <message>` or `KB <name> fails kb check: <finding>: <message>`.

## Digest

In `entries` mode (the default) the digest is the text appended to the bound `spec-answer` prompt, after the line `# Knowledge base digest`. It holds only entries with `status: verified` and no active flag, the same rule as citations. Entries are grouped by topic in file order:

```text
## model
- [demo.model.provider] Cloudberry Lantern は架空のモデル「灯り」を利用する。
  select: 利用AI=灯り; 提供元国=架空国
```

Each topic starts with `## <topic>`. Each entry is a `- [<id>] <claim>` line, followed by an indented `select:` line when the entry has `select`. `note` text is never included. The digest hash is the SHA-256 hex of this text. Drafts and eval runs on a bound persona record the hash, so a changed KB is visible. `eval run --run <id>` refuses to continue when the hash differs from the run.

## SSOT digest

By default the digest is built from entries. A KB can instead build it from a compiled single source of truth (SSOT): one document, `ssot.md`, that restates the verified entries as short statements grouped in sections. Entries stay the reviewed store. The SSOT adds no facts: every statement names the entries that back it.

### `ssot.md`

```text
# demo SSOT

## model
title: AI model

### demo.model.s1
text: Cloudberry Lantern は架空のモデル「灯り」を利用する。
backs: demo.model.provider
select: 利用AI=灯り
```

- The first line may be a `#` title. Blank lines are allowed. Any other text outside a section or statement block is a parse error.
- A section starts with `## <section>`. The name matches `^[a-z0-9][a-z0-9-]*$` and is unique. The `title:` line is one line of text.
- A statement starts with `### <kb>.<section>.s<n>`, where `<n>` is a positive integer without leading zeros. The id is unique and never equals an entry id.
- `text` and `backs` are required. `backs` lists existing entry ids separated by commas. `select` is optional and uses the same `key=value; key=value` form as an entry.
- Unknown keys and duplicate keys are parse errors.
- Once `ssot.md` exists, entry slugs of the form `s<n>` are refused, so a statement id can never look like an entry id.

### `ssot-approvals.jsonl`

One JSON row per approval. Only `bunshin kb ssot approve` writes it, and the last row for a section wins.

```json
{"id": "model", "approved_at": "2026-10-14T09:00:00.000Z", "text_hash": "<64 hex characters>", "backing_hash": "<64 hex characters>"}
```

`id` is the section name. `text_hash` is the SHA-256 of the section's canonical JSON (section, title and statements). `backing_hash` is the SHA-256 of the canonical JSON of its backing entries, sorted by id, with each entry's claim, select, status and whether it is flagged.

### Section states

| State | Meaning |
| --- | --- |
| `approved` | An approval row exists, both hashes match, and every backing entry is verified and unflagged. Only these sections are citable. |
| `draft` | No approval row. |
| `changed` | The section text differs from the approved text. |
| `stale` | A backing entry changed after approval, for example through `kb approve --resolve`. Approve the section again after you read it. |
| `blocked` | A backing entry is missing, not verified, or flagged. |

A change to one entry affects only the sections that use it.

### The `digest` key and the SSOT commands

`kb.json` may hold `"digest": "entries"` or `"digest": "ssot"`. A missing key means `entries`. Any other value is an error. Only `bunshin kb ssot enable` and `bunshin kb ssot disable` write the key. Drafting or approving sections never changes the digest, so an eval run does not change until you enable the SSOT.

| Command | Purpose |
| --- | --- |
| `bunshin kb ssot draft <name>` | Read one or more `## <section>` blocks from stdin. Replace sections of the same name in `ssot.md`, and append new ones. It creates the file with the title `# <name> SSOT` if needed. It prints `added <section>` or `replaced <section>`. |
| `bunshin kb ssot approve <name> <section>` | Append an approval row for the section and print `Approved <section>.` Only the owner runs it. |
| `bunshin kb ssot status <name>` | Print `<section>  <state>  <n> statements` per section, then `uncovered <n>` and the ids of verified, unflagged entries that no statement backs. |
| `bunshin kb ssot show <name> <section>` | Print the section block, then `state: <state>`. |
| `bunshin kb ssot enable <name>` | Set `"digest": "ssot"`. It refuses when no section is approved. |
| `bunshin kb ssot disable <name>` | Set `"digest": "entries"`. |

`kb ssot draft` refuses the whole input and writes nothing when a block does not parse, a backing id is unknown, not verified or flagged, a statement id equals an entry id, any entry slug is `s<n>`, or a section name, title, text or select value contains a scrub-list string, an email address or a phone number. The message names the section and the problem. It never prints the matched value. `kb ssot approve` applies the same checks to the section, and also refuses a section that does not exist.

### Digest and citations in `ssot` mode

The digest has one block per approved section, in file order:

```text
## model — AI model
- [demo.model.s1] Cloudberry Lantern は架空のモデル「灯り」を利用する。
  select: 利用AI=灯り
```

Only statements of approved sections are citable, so `kb cite`, the reply check, the digest and the support judge all use statement ids. An entry id is no longer citable: gate 3 reports `not-citable` for it. A section that is not approved is left out of the digest, and its statement ids report `not-citable`.

With `digest: ssot` and no approved section, `kb check` reports `ssot-empty`, binding refuses the KB, and shadow, spec answers and `eval run` stop with that finding. This also applies when every section becomes stale or blocked. Use `kb ssot status` to inspect the section states, then recover with `kb ssot approve` or switch back to entries with `kb ssot disable`.

Enabling or disabling the SSOT, or changing any approved section, changes the digest hash. An imported `coverage.json` then becomes `coverage_stale`, and `kb_gates` reports it until you run `coverage import` again. This is expected. Coverage labels keep entry ids in both modes: `coverage import` validates them against verified, unflagged, unique entries, while `kb_digest_hash` records the active mode's digest hash.

The support judge keeps the entry lookup in `entries` mode. In `ssot` mode it resolves ids through the citable statements and skips any sentence whose ids are not all citable. It does not send those sentences to the model and does not count them as supported. For example, `eval run --rejudge-from` on a run made in `entries` mode skips its cited sentences after you enable the SSOT, so that run cannot pass on them.

### Findings from `kb check`

| Finding | Meaning |
| --- | --- |
| `ssot-parse` | `ssot.md` does not parse. |
| `ssot-backs` | A statement backs an unknown entry. |
| `ssot-pii` | SSOT text contains an email address or a phone number. |
| `ssot-scrub` | SSOT text contains a scrub-list string. |
| `ssot-entry-slug` | An entry slug has the reserved form `s<n>` while `ssot.md` exists. |
| `ssot-empty` | `digest` is `ssot` and no section is approved. This includes the case where `ssot.md` is absent. |
| `ssot-approvals` | A row in `ssot-approvals.jsonl` is malformed. |

Findings name the file and line, and never print the matched value.

### Gate-1 ack allowlist

In `ssot` mode, and in `entries` mode too, a draft may open with one thanks line that needs no citation. Only the first non-empty line qualifies, and only when the whole line equals one of these phrases:

- `ありがとうございます！`
- `ありがとうございます。`
- `確認ありがとうございます！`
- `確認ありがとうございます。`
- `ご確認ありがとうございます！`
- `ご確認ありがとうございます。`
- `Thanks!`
- `Thanks for checking.`

That line is exempt: it is not counted in `shape.facts` and the support judge does not see it. A thanks phrase followed by more text on the same line, a second thanks line, or a thanks line that is not first is a normal sentence and needs a citation. A scrub-list string on the thanks line still fails the `scrub` gate. Headings are not exempt.

## Hand-back form

A bound persona does not answer a commitment, date, price or contract term, and does not choose between two digest entries that disagree. It replies with exactly one of these two-line forms, with no citation:

```text
要確認（人の判断が必要です）。
Reason: <one line>

Needs human.
Reason: <one line>
```

`kb cite` and the reply check accept this form like the abstain form. Every other factual sentence must end with a citation, and a sentence that contains a scrub-list string fails with `scrub`. When asked to check a draft or an understanding, the reply confirms the supported parts in one short first sentence and names only what is wrong or unsupported.

## Compiler commands

These commands write draft entries. They read JSON Lines from stdin: one object per line, blank lines ignored. A batch is all-or-nothing: if any row fails, nothing is written and the first failing row is reported. Field values containing CR, LF, NUL, U+2028 or U+2029 are refused. Before writing drafts, every prepared entries file is parsed with the KB loader's parser; a parse error refuses the batch with its row number. Rows with scrub-list, email or phone hits are refused.

`bunshin kb sources add <name>` registers sources in `sources.jsonl`. It prints `S<nn>  <label>` per row.

```json
{"kind": "notion", "label": "Cloudberry Lantern overview page, 2026-10-12", "ref": "https://example.invalid/overview", "answered_at": "2026-10-12"}
```

`kind` is `sheet`, `slack` or `notion`. `id`, `file_sha256` and `superseded_by` are optional. Without `id`, the next free `S<nn>` is assigned. An existing `id`, `ref` or `file_sha256` is refused. Duplicate references and hashes report `Row <n>: Source ref already exists as S<nn>.` or `Row <n>: Source file_sha256 already exists as S<nn>.` with exit 1 and nothing written. The compiler skill reuses that existing id for `kb draft` and `kb stale` and continues.

`bunshin kb draft <name>` appends entries with `status: draft` to `entries/<topic>.md`. It prints each added id, then runs `kb check` and exits 1 with the findings if there are any.

```json
{"id": "demo.model.provider", "claim": "Cloudberry Lantern は架空のモデル「灯り」を利用する。", "sources": ["S01#overview"], "select": {"利用AI": "灯り"}, "note": "optional", "answers": [{"row_id": 3, "cell": "E3", "question": "利用AI", "answer": "灯り", "answer_type": "select"}]}
```

`id` must start with `<kb name>.` and must not exist in any status. Every `sources` reference must name a registered source. `select`, `note` and `answers` are optional; each `answers` row is appended to `answers.jsonl` with the entry id and the first source.

`bunshin kb stale <name> --source S<nn> --changed-at <YYYY-MM-DD> [--reason <text>] [--dry-run]` flags freshness. It prints `flagged <id>` or `skipped <id>` per match and exits 0 even when nothing matches. The `/bunshin:kb-compile` skill runs these commands; the owner still runs `kb approve`. To restate the verified entries as an SSOT, run the `/bunshin:kb-ssot` skill; it runs only `kb ssot draft` and `kb ssot status`, and the owner runs `kb ssot approve` and `kb ssot enable`.

## Freshness

An entry is stale when its source changed after the entry was verified. `kb stale` flags each `verified` entry that cites the given source and has a `verified` date before `--changed-at`, by appending a row to `flags.jsonl`:

```json
{"id": "demo.model.provider", "flagged": true, "reason": "source S01 changed 2026-11-01", "at": "2026-11-02T09:00:00.000Z"}
```

Without `--reason`, the reason is `source <S id> changed <date>`. An entry whose latest flag row is already `flagged: true` with the same reason is skipped. A flagged entry leaves the digest and cannot be cited until `kb unflag` clears the flag. `--dry-run` prints the result and writes nothing.

## Commands

| Command | Purpose |
| --- | --- |
| `bunshin kb init <name> [--sample]` | Create a KB. |
| `bunshin kb check <name>` | Check grammar, ids, sources, scrub list and flags. |
| `bunshin kb list <name>` | List entries, optionally by `--status` or `--topic`. |
| `bunshin kb show <name> <id>` | Show one entry. |
| `bunshin kb approve <name> <id>` | Mark an entry verified. |
| `bunshin kb flag <name> <id> --reason <text>` | Flag an entry as stale or disputed. |
| `bunshin kb unflag <name> <id>` | Clear the flag. |
| `bunshin kb cite <name> --draft <file>` | Check a draft's citations against the KB. |
| `bunshin kb sources add <name>` | Register sources from JSON Lines on stdin. |
| `bunshin kb draft <name>` | Add draft entries from JSON Lines on stdin. |
| `bunshin kb stale <name> --source S<nn> --changed-at <date>` | Flag verified entries whose source changed. |
| `bunshin kb ssot draft\|approve\|status\|show\|enable\|disable <name>` | Manage the compiled SSOT (see SSOT digest). |

An entry is flagged unless the latest row for it in `flags.jsonl` has `flagged: false`.
