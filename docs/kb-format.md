# Knowledge base format

A knowledge base (KB) holds reviewed, citable facts about one product. It is separate from a persona: the persona decides tone, the KB decides facts.

A KB lives at `$BUNSHIN_HOME/kb/<name>`. Its content never belongs in this repository. The repository ships only the synthetic sample KB `sample/kb/demo`, which describes the fictional product Cloudberry Lantern. Create it with `bunshin kb init demo --sample`.

## Layout

| Path | Contents |
| --- | --- |
| `kb.json` | Manifest: `format_version` 1, `name`, `product`, `synthetic`, `languages`. |
| `entries/<topic>.md` | One file per topic. Entries are `### <id>` blocks. |
| `sources.jsonl` | Provenance registry, one row per source document. |
| `answers.jsonl` | Extraction log: which source row produced which answer, mapped to which entry. |
| `flags.jsonl` | Freshness and conflict flags. Append-only. |
| `README.md` | Generated index: topics and entry counts by status. |

The sample KB ships only `kb.json`, `entries/` and `sources.jsonl`.

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

Only `verified`, unflagged entries are citable. When no entry covers the question, the answer abstains and names the nearest topic:

```text
該当する情報がありません。
Closest topic: model

Not covered.
Closest topic: model
```

## Binding a persona

A persona uses a KB when its `persona.json` has the optional field `"kb": "demo"`. The value must match `/^[a-z0-9][a-z0-9-]*$/`; any other type or form makes the manifest invalid. Without the field the persona is unbound and its prompts and drafts are unchanged.

For a bound persona, the `spec-answer` prompt switches to the KB template. The template tells the model to cite only the digest, so the model needs no tools. If the KB is missing, has parse errors or fails `kb check`, `twin prompt`, `shadow draft` and `eval run` exit 1 with `KB <name> not found`, `KB <name> has parse errors: <file>:<line> <message>` or `KB <name> fails kb check: <finding>: <message>`.

## Digest

The digest is the text appended to the bound `spec-answer` prompt, after the line `# Knowledge base digest`. It holds only entries with `status: verified` and no active flag, the same rule as citations. Entries are grouped by topic in file order:

```text
## model
- [demo.model.provider] Cloudberry Lantern は架空のモデル「灯り」を利用する。
  select: 利用AI=灯り; 提供元国=架空国
```

Each topic starts with `## <topic>`. Each entry is a `- [<id>] <claim>` line, followed by an indented `select:` line when the entry has `select`. `note` text is never included. The digest hash is the SHA-256 hex of this text. Drafts and eval runs on a bound persona record the hash, so a changed KB is visible. `eval run --run <id>` refuses to continue when the hash differs from the run.

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

`bunshin kb stale <name> --source S<nn> --changed-at <YYYY-MM-DD> [--reason <text>] [--dry-run]` flags freshness. It prints `flagged <id>` or `skipped <id>` per match and exits 0 even when nothing matches. The `/bunshin:kb-compile` skill runs these commands; the owner still runs `kb approve`.

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

An entry is flagged unless the latest row for it in `flags.jsonl` has `flagged: false`.
