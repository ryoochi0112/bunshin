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
該当する情報がありません。Closest topic: model
Not covered. Closest topic: model
```

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

An entry is flagged unless the latest row for it in `flags.jsonl` has `flagged: false`.
