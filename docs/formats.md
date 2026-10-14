# Persona formats

Bunshin stores each persona in one directory. Set `BUNSHIN_HOME` to choose the parent directory. It defaults to `~/bunshin-personas`.

Pass `--persona <dir>` or set `BUNSHIN_PERSONA` to select a persona. Bunshin uses the only persona in the home directory when there is exactly one.

Files use UTF-8. A JSONL file has one JSON object on each line. Each format uses version 1. JSONL records inherit version 1 from `persona.json` unless a record has its own `format_version` field.

The sample persona is fictional. It uses the name Sora Aoki and the fictional product Tidepool.

## Persona directory

| Path | Contents |
| --- | --- |
| `persona.json` | Persona manifest and format version. |
| `pairs.jsonl` | Question and answer pairs. |
| `split.json` | Pair assignments for build and held-out sets. |
| `cases.jsonl` | Test cases derived from held-out pairs. |
| `interview.jsonl` | Answered interview questions. |
| `interview-state.json` | Current interview session state. It is created when a session begins. |
| `conflicts.jsonl` | Conflicts between interview answers and observed behavior. |
| `identity.json` | Identity traits and their evidence. |
| `identity.md` | Rendered identity. Bunshin creates it from `identity.json`. |
| `coverage.json` | Optional held-out coverage labels for a bound knowledge base. `bunshin coverage import` creates it. |

The sample has no `interview-state.json` because it has no active session.

## Persona manifest: `persona.json`

`persona.json` has `format_version: 1`. Its version starts at 0 and advances when an identity is committed.

| Field | Meaning |
| --- | --- |
| `format_version` | Format version. It is `1`. |
| `name` | Lowercase persona directory name. |
| `display_name` | Name shown in the rendered identity. |
| `synthetic` | Whether the persona contains synthetic sample data. |
| `owner.slack_user_id` | Slack user id for the owner, or `null`. |
| `version` | Current committed identity version. |
| `kb` | Optional bound KB name matching `/^[a-z0-9][a-z0-9-]*$/`, for example `"demo"`. Omit it for an unbound persona. |
| `launch_bar.send_as_is` | Required send-as-is rate. The default is `0.5`. |
| `launch_bar.min_heldout` | Minimum held-out case count. The default is `30`. |
| `launch_bar.min_per_layer` | Minimum cases in each layer. The default is `10`. |
| `launch_bar.min_agreement` | Minimum judge agreement. The default is `0.8`. |
| `hosts.claude.allowed_tools` | Tool names allowed for the Claude host. |

### Example: `persona.json`

```json
{
  "format_version": 1,
  "name": "sample",
  "display_name": "Sora Aoki",
  "synthetic": true,
  "owner": {
    "slack_user_id": null
  },
  "version": 1,
  "launch_bar": {
    "send_as_is": 0.5,
    "min_heldout": 30,
    "min_per_layer": 10,
    "min_agreement": 0.8
  },
  "hosts": {
    "claude": {
      "allowed_tools": []
    }
  }
}
```

## Pair record: `pairs.jsonl`

Each line is one harvested or manually added question and answer pair. `format_version` is optional on a record. If present, its value must be `1`.

| Field | Meaning |
| --- | --- |
| `format_version` | Optional record version. The persona version applies when it is absent. |
| `id` | Lowercase id containing letters, digits, and hyphens. |
| `source` | `slack` or `manual`. |
| `permalink` | Link to the source discussion. |
| `channel` | Source channel name or id. |
| `asked_at` | Time of the question in an ISO date format. |
| `layer` | `knowledge` or `judgment`. |
| `layer_source` | `auto` or `manual`. |
| `question` | Question object. |
| `question.author` | Author of the question. |
| `question.text` | Question text. |
| `context` | List of context messages. |
| `context[].author` | Author of a context message. |
| `context[].text` | Text of a context message. The context list may be empty. |
| `answer` | Answer object. |
| `answer.text` | Answer text. |
| `harvested_at` | Time when the pair was added. |

### Example: `pairs.jsonl`

```json
{"id":"sample-01","source":"manual","permalink":"https://example.invalid/tidepool/threads/sample-01","channel":"tidepool-fictional-design","asked_at":"2026-01-10T09:00:00.000Z","layer":"knowledge","layer_source":"manual","question":{"author":"Mira Pebble","text":"How long does Tidepool keep a saved preview?"},"context":[{"author":"Sora Aoki","text":"This is a fictional Tidepool design discussion in a sandbox."}],"answer":{"text":"A saved preview stays available for seven days. The card shows its expiry date; saving a new preview does not extend an older one."},"harvested_at":"2026-01-11T09:00:00.000Z"}
```

## Split: `split.json`

`split.json` is the authority for pair assignment. Existing assignments do not change when new pairs are added.
The default held-out ratio is `0.3`. New ids use `SHA-256(salt + ":" + pair id)` to select a set.

| Field | Meaning |
| --- | --- |
| `format_version` | Format version. It is `1`. |
| `salt` | Salt used to assign new pair ids. |
| `heldout_ratio` | Fraction used for new held-out assignments. |
| `assignments` | Map of pair ids to set names. |
| `assignments.<pair_id>` | `build` or `heldout`. |

### Example: `split.json`

```json
{
  "format_version": 1,
  "salt": "74696465706f6f6c",
  "heldout_ratio": 0.3,
  "assignments": {
    "sample-01": "build",
    "sample-02": "build",
    "sample-03": "build",
    "sample-04": "build",
    "sample-05": "build",
    "sample-06": "build",
    "sample-07": "build",
    "sample-08": "build",
    "sample-09": "build",
    "sample-10": "heldout",
    "sample-11": "build",
    "sample-12": "heldout",
    "sample-13": "heldout",
    "sample-14": "build",
    "sample-15": "build",
    "sample-16": "build"
  }
}
```

## Case record: `cases.jsonl`

Each line is a held-out pair copied into the evaluation case shape. The case contains the reference answer.

| Field | Meaning |
| --- | --- |
| `id` | Id of the held-out pair. |
| `layer` | `knowledge` or `judgment`. |
| `question` | Question object. |
| `question.author` | Author of the question. |
| `question.text` | Question text. |
| `context` | List of context messages. |
| `context[].author` | Author of a context message. |
| `context[].text` | Text of a context message. |
| `reference_answer` | Answer from the held-out pair. |
| `permalink` | Link to the source discussion. |

### Example: `cases.jsonl`

```json
{"id":"example-01","layer":"judgment","question":{"author":"Lena Shell","text":"Should we add a sound when a Tidepool sandbox task finishes?"},"context":[{"author":"Oren Reed","text":"The fictional Tidepool sandbox has a silent task status panel."}],"reference_answer":"Make the sound optional. Test it with sandbox volunteers and check whether it helps them notice completed tasks without interrupting their work.","permalink":"https://example.invalid/tidepool/threads/example-01"}
```

## Interview answer: `interview.jsonl`

Each line records one answered question. A gap explains why the current sources cannot answer the question.

| Field | Meaning |
| --- | --- |
| `id` | Interview answer id, such as `iv-0001`. |
| `session` | Interview session id. |
| `asked_at` | Time when the question was asked. |
| `topic` | Interview topic. |
| `gap` | Reason the sources cannot show the answer. |
| `question` | Interview question. |
| `answer` | Owner's answer. |

### Example: `interview.jsonl`

```json
{"id":"iv-0001","session":"session-0001","asked_at":"2026-01-12T09:00:00.000Z","topic":"rollout","gap":"The discussions show pilot choices but not the reason for the rollout policy.","question":"Would you always choose a broad launch if the team has finished its review?","answer":"I initially think a broad launch is fine once a review is complete. For unfamiliar workflows, though, I want a small pilot with a clear signal before expanding."}
```

## Interview state: `interview-state.json`

This file records a session that can resume after interruption. `pending` is `null` when no question is waiting for an answer.
One session allows at most 15 questions. A pending question must have a non-empty gap.

| Field | Meaning |
| --- | --- |
| `format_version` | Format version. It is `1`. |
| `session` | Current session id. |
| `asked` | Number of questions asked in this session. |
| `pending` | Pending question object, or `null`. |
| `pending.asked_at` | Time when the pending question was asked. |
| `pending.topic` | Topic of the pending question. |
| `pending.gap` | Reason the sources do not answer it. |
| `pending.question` | Pending question text. |

The sample persona has no interview-state example because it has no active session.

## Conflict record: `conflicts.jsonl`

Each line links an interview answer to observed build-set pairs. A conflict can remain open or record a resolution.

| Field | Meaning |
| --- | --- |
| `id` | Conflict id, such as `cf-0001`. |
| `claim` | Claim that needs comparison with observed behavior. |
| `interview_ref` | Id of the interview answer. |
| `behaviour_refs` | Ids of build-set pairs. |
| `status` | `open` or `resolved`. |
| `resolution` | `null`, `behaviour`, `self_report`, or `context`. |
| `note` | Resolution note, or `null`. |

### Example: `conflicts.jsonl`

```json
{"id":"cf-0001","claim":"A completed review always justifies a broad launch, while observed choices favour a pilot.","interview_ref":"iv-0001","behaviour_refs":["sample-02"],"status":"resolved","resolution":"context","note":"A review is enough for a familiar workflow; unfamiliar workflows still need a limited pilot."}
```

## Identity: `identity.json` and `identity.md`

`identity.json` is the source of truth. An identity trait needs evidence from a pair or an interview answer. Pair evidence includes its source permalink.

| Field | Meaning |
| --- | --- |
| `format_version` | Format version. It is `1`. |
| `persona` | Persona name from `persona.json`. |
| `version` | Identity version. |
| `built_at` | Time when Bunshin committed the identity. |
| `voice` | List of voice traits. |
| `priorities` | List of priorities. |
| `objections` | List of objections. |
| `context_rules` | List of context rules. |
| `trait.id` | Lowercase trait id. |
| `trait.statement` | Trait statement. |
| `trait.evidence` | Evidence entries for the trait. |
| `trait.conflict` | Optional id of a resolved conflict. |
| `priority.name` | Name of a priority. |
| `objection.priority` | Id of the priority named by an objection. |
| `evidence.type` | `pair` or `interview`. |
| `evidence.ref` | Id of the pair or interview answer. |
| `evidence.permalink` | Source link for pair evidence. Interview evidence has no permalink. |

### Example: `identity.json`

```json
{
  "format_version": 1,
  "persona": "sample",
  "version": 1,
  "voice": [
    {
      "id": "voice-direct",
      "statement": "Lead with a clear answer, then explain its boundary in plain language.",
      "evidence": [
        {
          "type": "pair",
          "ref": "sample-01",
          "permalink": "https://example.invalid/tidepool/threads/sample-01"
        }
      ]
    },
    {
      "id": "voice-language",
      "statement": "Use the question's language and concrete descriptions of the next action.",
      "evidence": [
        {
          "type": "pair",
          "ref": "sample-03",
          "permalink": "https://example.invalid/tidepool/threads/sample-03"
        }
      ]
    }
  ],
  "priorities": [
    {
      "id": "priority-evidence",
      "name": "Evidence before scale",
      "statement": "Evidence before scale: expand an unfamiliar workflow after a focused pilot produces a useful signal.",
      "evidence": [
        {
          "type": "pair",
          "ref": "sample-02",
          "permalink": "https://example.invalid/tidepool/threads/sample-02"
        },
        {
          "type": "interview",
          "ref": "iv-0001"
        }
      ],
      "conflict": "cf-0001"
    },
    {
      "id": "priority-reversibility",
      "name": "Reversibility",
      "statement": "Reversibility: preserve a practical route back while trying a new approach.",
      "evidence": [
        {
          "type": "pair",
          "ref": "sample-04",
          "permalink": "https://example.invalid/tidepool/threads/sample-04"
        }
      ]
    },
    {
      "id": "priority-clarity",
      "name": "Reader clarity",
      "statement": "Reader clarity: make observations, uncertainty, and the next decision easy to distinguish.",
      "evidence": [
        {
          "type": "pair",
          "ref": "sample-06",
          "permalink": "https://example.invalid/tidepool/threads/sample-06"
        },
        {
          "type": "interview",
          "ref": "iv-0002"
        }
      ]
    }
  ],
  "objections": [
    {
      "id": "objection-scope",
      "priority": "priority-evidence",
      "statement": "What evidence supports widening the rollout beyond a small trial?",
      "evidence": [
        {
          "type": "pair",
          "ref": "sample-02",
          "permalink": "https://example.invalid/tidepool/threads/sample-02"
        }
      ]
    },
    {
      "id": "objection-rollback",
      "priority": "priority-reversibility",
      "statement": "How will people recover their previous workflow if the experiment causes confusion?",
      "evidence": [
        {
          "type": "pair",
          "ref": "sample-04",
          "permalink": "https://example.invalid/tidepool/threads/sample-04"
        }
      ]
    }
  ],
  "context_rules": [
    {
      "id": "context-unverified",
      "statement": "When a product rule cannot be verified, say so and request a current source before making a commitment.",
      "evidence": [
        {
          "type": "interview",
          "ref": "iv-0003"
        }
      ]
    }
  ],
  "built_at": "2026-10-04T07:33:56.355Z"
}
```

`identity.md` is rendered from `identity.json`. Bunshin writes the header, then the Voice, Priorities, Typical objections, and Context rules sections. Each trait appears as a bullet with evidence links below it. Do not edit `identity.md` by hand.

## Draft record: `drafts.jsonl`

Each line in `evals/<run_id>/drafts.jsonl` records a draft. The layer recorded here determines the report layer, even if a case is later relabeled.

| Field | Meaning |
| --- | --- |
| `case_id` | Held-out case id. |
| `layer` | `knowledge` or `judgment`. |
| `skill` | `spec-answer` or `idea-discussion`. |
| `draft` | Generated answer text. |
| `drafter` | Host and returned model object. |
| `drafter.host` | Host that generated the draft. |
| `drafter.model` | Recorded model name, or `null` for default. |
| `at` | ISO timestamp of the draft. |
| `kb` | Present only on `spec-answer` rows for a bound persona: `{name, digest_hash}`. |
| `kb.name` | Bound knowledge base name, for example `demo`. |
| `kb.digest_hash` | SHA-256 hex hash of the citable digest used for this draft. |
| `cited` | Present only on `spec-answer` rows for a bound persona: unique cited entry ids in answer order. Unknown and non-citable ids are included; scrubbed ids are omitted. |
| `gates` | Present only on `spec-answer` rows for a bound persona: four independent structural-check booleans. |
| `gates.citation` | `false` when any sentence has a `no-citation` problem. |
| `gates.resolves` | `false` when any sentence has an `unknown-id` problem. |
| `gates.current` | `false` when any sentence has a `not-citable` problem (including draft, conflict, retired or flagged entries). |
| `gates.scrub` | `false` when any sentence has a `scrub` problem against the KB's optional sibling `<name>.scrub.txt` file. |
| `shape` | Present only on `spec-answer` rows for a bound persona: the form of the answer, `{abstain, handback, facts}`. |
| `shape.abstain` | `true` when the draft contains the exact two-line abstain form. |
| `shape.handback` | `true` when the draft contains the exact two-line hand-back form. |
| `shape.facts` | Integer count of sentences that are not exempt. Exempt lines are the abstain form, the hand-back form and `>` quotes. |

Bound personas draft `spec-answer` cases with `tools: 'none'` and no `allowedTools`. The bound KB must parse and pass `kb check` before its digest is used. The gates come from `checkSpecReply` against the loaded KB and scrub list; they do not change the judge loop or establish factual correctness. The exact abstain and hand-back forms pass the citation gates, while their details still receive the scrub check. `idea-discussion` cases on bound personas and all cases on unbound personas use `tools: 'notion-read'` with `allowedTools` and omit `kb`, `cited`, `gates` and `shape`.

### Example: `drafts.jsonl`

```json
{"case_id":"sample-10","layer":"judgment","skill":"idea-discussion","draft":"Try two search labels before widening the experiment.","drafter":{"host":"fake","model":"fake"},"at":"2026-10-20T00:00:00.000Z"}
```

`shape` records what kind of answer the draft is, so that `eval report` can compare it with a coverage label. It is computed from the same check as `gates` and adds no model call. A `spec-answer` row on a bound persona looks like this, using the demo KB:

### Example: bound `spec-answer` row

```json
{"case_id":"sample-13","layer":"knowledge","skill":"spec-answer","draft":"Cloudberry Lantern uses the fictional model Akari. [demo.model.provider]","drafter":{"host":"fake","model":"fake"},"at":"2026-10-20T00:00:00.000Z","kb":{"name":"demo","digest_hash":"6aa2e609f7b5a5bb10967907697ca9097d4f5375a7081a33046bcf8ea691c927"},"cited":["demo.model.provider"],"gates":{"citation":true,"resolves":true,"current":true,"scrub":true},"shape":{"abstain":false,"handback":false,"facts":1}}
```

An abstaining draft has `"shape":{"abstain":true,"handback":false,"facts":0}`. A hand-back after one cited fact has `"shape":{"abstain":false,"handback":true,"facts":1}`. Rows from runs made before `shape` existed have no `shape`; the report grades them as `ungraded`.

Shadow stores one draft object in `shadow/<id>/draft.json` with the same `layer`, `skill`, `draft`, `drafter`, `at` and optional `kb`/`cited`/`gates` fields, present only for bound-persona `spec-answer` drafts. It uses `format_version: 1` and `id` instead of `case_id`. When gates are present, `shadow show` prints a line after the draft, for example `gates: citation=true resolves=true current=true scrub=true`.

## Run record: `run.json`

`evals/<run_id>/run.json` pins the persona version, drafter and judge settings, rubric, judge examples, vote count, start time and optional limit. A new run on a bound persona also records `kb: {name, digest_hash}`, using the same KB name and SHA-256 digest hash as its `spec-answer` draft rows, even when the run selects only `idea-discussion` cases. Unbound runs omit `kb`.

`eval run --run <run_id>` refuses a changed digest with `eval run: kb digest differs from run` before any host call or run-file write. Adding or removing a persona's KB binding also changes the digest comparison. `eval run --rejudge-from <run_id>` copies the source run's `kb` metadata and draft rows, including their `cited` and `gates` fields, even if the current KB has changed. It judges the saved drafts without recomposing or drafting them.

A new run on a bound persona also records `support_rubric`, the first 16 hex characters of the SHA-256 hash of `templates/support-judge.md` (the support judge's system text). Unbound runs omit it. `eval run --run <run_id>` on a bound persona refuses a changed hash with `eval run: support rubric differs from run`. A bound run made before `support_rubric` existed has no hash, so it cannot be resumed; start a new run instead. `--rejudge-from` always records the current `support_rubric` for the new run.

### Example: `run.json`

```json
{"run_id":"2026-10-20-01","persona_version":1,"drafter":{"host":"fake","model":null},"judge":{"host":"fake","model":null},"judge_rubric":"228729cf56f6ff4c","judge_examples":null,"judge_votes":3,"started_at":"2026-10-20T00:00:00.000Z","limit":null,"kb":{"name":"demo","digest_hash":"6aa2e609f7b5a5bb10967907697ca9097d4f5375a7081a33046bcf8ea691c927"},"support_rubric":"e7d793a16fd6b136"}
```

## Support record: `support.jsonl`

A bound run also writes `evals/<run_id>/support.jsonl`. This is gate 4: a separate judge call per cited sentence asks whether the cited KB entries support that sentence. It runs for each `spec-answer` draft after the draft (or the draft copied by `--rejudge-from`) and before the send-as-is judge. The judge is the run's `judge` host and model. Each call is made with `tools: 'none'` and sees only the one sentence and the `id`, `claim` and `select` of the entries it cites. It never sees the question, context, reference answer, entry `note` or other sentences. The row stores no sentence text and no entry text.

A sentence is judged only when it is not exempt, cites at least one id, every id resolves to exactly one entry, and the sentence is not `[redacted]`. Other sentences get no entry in `sentences`; the report treats them through the structural gates instead. Malformed judge output is retried once, then recorded as `support_error`. A host error stops the run with the usual resume message, and a resumed run skips cases that already have a row.

| Field | Meaning |
| --- | --- |
| `case_id` | Held-out case id of a `spec-answer` draft. |
| `sentences` | One object per judged sentence, in draft order. |
| `sentences[].index` | Zero-based index of the sentence among the sentences found in the draft. |
| `sentences[].ids` | Cited entry ids of that sentence. |
| `sentences[].verdict` | `supported`, `partly` (any part of the sentence is not stated by the entries), `not_supported`, or `support_error`. |
| `judge` | Host and returned model object. |
| `judge.host` | Judge host. |
| `judge.model` | Recorded model name, or `null` for default. |
| `at` | ISO timestamp when the row was written, after all verdicts for the case are in. |

### Example: `support.jsonl`

```json
{"case_id":"sample-13","sentences":[{"index":0,"ids":["demo.model.provider"],"verdict":"supported"}],"judge":{"host":"fake","model":"fake"},"at":"2026-10-20T00:00:00.000Z"}
```

## Judgment record: `judgments.jsonl`

Each line in `evals/<run_id>/judgments.jsonl` contains a validated judge result or a `judge_error`. Wrong uncited facts count claims with `cited: false` and `correct: false`.

| Field | Meaning |
| --- | --- |
| `case_id` | Held-out case id. |
| `rating` | `send_as_is`, `needs_edits`, `wrong`, or `judge_error`. |
| `reason` | Judge explanation; errors use `invalid judge output`. |
| `claims` | Claim list; absent on `judge_error`. |
| `claims[].text` | Claim text. |
| `claims[].cited` | Whether the claim has a citation. |
| `claims[].correct` | `true`, `false`, or `null` when unknown. |
| `wrong_uncited` | Count of wrong uncited claims; absent on `judge_error`. |
| `language_match` | Whether the language matches the question; absent on `judge_error`. |
| `votes` | Three per-call judge votes; absent on `judge_error` rows. |
| `votes[].rating` | Rating from one judge call. |
| `votes[].wrong_uncited` | Wrong uncited count from one judge call. |
| `votes[].language_match` | Language match from one judge call. |
| `votes[].model` | Model returned by that call, or `null` for default. |
| `judge` | Host and returned model object. |
| `judge.host` | Judge host. |
| `judge.model` | Recorded model name, or `null` for default. |
| `at` | ISO timestamp of the judgment. |

### Example: `judgments.jsonl`

```json
{"case_id":"sample-10","rating":"send_as_is","reason":"The draft preserves the small experiment.","claims":[],"wrong_uncited":0,"language_match":true,"votes":[{"rating":"send_as_is","wrong_uncited":0,"language_match":true,"model":"fake"},{"rating":"send_as_is","wrong_uncited":0,"language_match":true,"model":"fake"},{"rating":"needs_edits","wrong_uncited":0,"language_match":true,"model":"fake"}],"judge":{"host":"fake","model":"fake"},"at":"2026-10-20T00:00:00.000Z"}
```

After two invalid judge responses, the error row contains only the following fields. It is excluded from rates and counted separately as `judge_errors`.

### Example: `judge_error`

```json
{"case_id":"sample-12","rating":"judge_error","reason":"invalid judge output","judge":{"host":"fake","model":"fake"},"at":"2026-10-20T00:00:00.000Z"}
```

## Report: `report.json` and `report.md`

`eval report` writes both files under `evals/<run_id>/`, replacing JSON first and Markdown second through atomic writes. Rerunning restores both files after interruption. Without `--run`, it selects the latest date and then numeric sequence. Deltas compare judge rates against the latest earlier run with a report.

Judge statistics always appear. Their denominator excludes judge errors and drafts without judgments. Trust requires at least 30 calibration ratings and agreement at least `launch_bar.min_agreement` (spec §7 rule 4). A run without its own ratings inherits agreement from the latest run that has ratings and the same judge host, model, rubric hash, examples hash, vote count and recorded judge models. Each new run records the rubric hash of `templates/judge.md` in `run.json`, so editing the rubric resets trust to `uncalibrated`. Each new run also records `judge_examples` and `judge_votes` in `run.json`. `judge_examples` is `null` when the persona has no owner example set; otherwise it is `{hash, n, labels: {send_as_is, needs_edits, wrong}, reasons}` for the examples placed in the judge system text. `reasons` is the number of examples whose latest rating carries a non-empty owner reason; the reason text itself is never copied out of `judge-examples/ratings.jsonl`. Runs recorded before reasons existed have no `reasons` field. `judge_votes` is the integer number of judge calls per case, currently `3`. `eval run --run` refuses to resume when either value differs from the current examples or vote count. Runs made before the hash or `judge_votes` existed never share trust. An untrusted or uncalibrated judge leaves the launch bar dependent on owner ratings for this run alone.

`eval run --rejudge-from <run_id>` starts a new run that copies the source run's drafts and judges them with the current rubric. It never drafts. The owner already saw those drafts, so a re-judged run cannot be calibrated. `calibrate compare --run <run_id>` prints its agreement with the source run's ratings as a tuning-set check that never sets trust. The bar applies `launch_bar.min_heldout`, `min_per_layer`, and `send_as_is`, plus zero knowledge wrong uncited facts.

| Field | Meaning |
| --- | --- |
| `format_version` | Report format version, `1`. |
| `persona` | Persona name. |
| `display_name` | Owner's display name. |
| `run_id` | Run date and numeric sequence. |
| `persona_version` | Version saved in the run, independent of current version. |
| `heldout` | Held-out case counts from `cases.jsonl`, drafted or not: `n`, `knowledge`, `judgment`. |
| `knowledge` | Judge statistics: `n`, `send_as_is`, `send_as_is_rate`, `wrong_uncited`. |
| `judgment` | Same judge statistics for the judgment layer. |
| `overall_rate` | Total judge send-as-is divided by valid judgments; `null` when empty. |
| `delta` | Per-layer change in rounded percentage points; `null` without comparable rates. |
| `drafter` | `host` and distinct recorded `models` list. |
| `judge` | `host` and distinct recorded `models` list, including judge errors. |
| `judge_rubric` | Judge rubric hash saved in the run, or `null` for older runs. |
| `judge_examples` | Owner examples used by the judge, `{hash, n, labels, reasons}`, or `null` for none. `reasons` counts examples with an owner reason (a count only, never reason text) and is absent for older runs. |
| `judge_votes` | Judge calls per case saved in the run; `1` for older runs. |
| `rejudged_from` | Source run whose drafts this run re-judged, or `null`. |
| `judge_trust` | `trusted`, `untrusted`, or `uncalibrated`. |
| `agreement` | `{match, rated}`, or `null` without calibration. |
| `trust_from` | Run whose ratings supplied `agreement` when this run has none, or `null`. Runs with an unreported judge model never share trust. |
| `basis` | `judge` when trusted, otherwise `owner_ratings`. |
| `bar_n` | Valid case ratings counted for the selected launch-bar basis. |
| `launch_bar` | `met`, `not_met`, or `sample_too_small`. |
| `judge_errors` | Number of judge-error rows, excluded from rates. |
| `unjudged` | Drafted cases with no judgment row. |
| `undrafted` | Held-out cases with no draft. |
| `complete` | `true` only when every held-out case has a draft and a judgment row (judge errors count) and the run has no `limit`. Otherwise `launch_bar` is `sample_too_small`. |

### Example: `report.json`

```json
{
  "format_version": 1,
  "persona": "sample",
  "display_name": "Sora Aoki",
  "run_id": "2026-10-20-01",
  "persona_version": 1,
  "heldout": {
    "n": 1,
    "knowledge": 0,
    "judgment": 1
  },
  "knowledge": {
    "n": 0,
    "send_as_is": 0,
    "send_as_is_rate": null,
    "wrong_uncited": 0
  },
  "judgment": {
    "n": 1,
    "send_as_is": 1,
    "send_as_is_rate": 1,
    "wrong_uncited": 0
  },
  "overall_rate": 1,
  "delta": {
    "knowledge": null,
    "judgment": null
  },
  "drafter": {
    "host": "fake",
    "models": [
      "fake"
    ]
  },
  "judge": {
    "host": "fake",
    "models": [
      "fake"
    ]
  },
  "judge_rubric": null,
  "judge_examples": null,
  "judge_votes": 1,
  "rejudged_from": null,
  "judge_trust": "uncalibrated",
  "agreement": null,
  "trust_from": null,
  "basis": "owner_ratings",
  "bar_n": 0,
  "launch_bar": "sample_too_small",
  "judge_errors": 0,
  "unjudged": 0,
  "undrafted": 0,
  "complete": true
}
```

### Example: `report.md`

```text
bunshin eval — persona sample @ v1 — 2026-10-20
held-out: 1 pairs (knowledge 0, judgment 1)
knowledge: send as-is n/a · wrong fact without citation 0
judgment:  send as-is 100%
overall:   send as-is 100%  → sample too small
judge agreement with Sora Aoki: not calibrated → uncalibrated
drafter: fake fake · judge: fake fake
judge examples: none · 1-call vote
launch bar basis: Sora Aoki's ratings (0 rated)
```

The Markdown layout has eight required lines: persona/version/date, drafted counts, knowledge judge rate and wrong uncited facts, judgment judge rate, overall judge rate and bar status, calibration agreement and trust, then drafter and judge hosts and models, then judge examples and vote count (`judge examples: <n> (send_as_is a · needs_edits b · wrong c · reasons r) · <votes>-call vote`, or `judge examples: none · <votes>-call vote`). Runs whose `judge_examples` has no `reasons` field print `judge examples: <n> (send_as_is a · needs_edits b · wrong c) · <votes>-call vote`. Percentages use `Math.round(100 * rate)`; empty rates print `n/a`. Only per-layer rates have deltas, formatted `(+8)`, `(-3)`, or `(+0)`. Models are distinct recorded values joined by `, `; `null` or an empty list prints `default`.

After those lines, show only applicable lines in this order: `judge errors: <n> (excluded from rates)` when nonzero, `not judged: <n>` when nonzero, `not drafted: <n>` when nonzero, `incomplete: <done> of <n> held-out cases drafted and judged — no launch-bar claim` when `complete` is false, and `launch bar basis: <display_name>'s ratings (<n> rated)` whenever the basis is owner ratings. The file ends with one newline.


## Coverage labels: `coverage.json`

`bunshin coverage import <file>` writes `<persona>/coverage.json`: the owner's labels saying, for each held-out case, how well the bound knowledge base covers the question. The labels turn a draft's shape into a graded outcome in the report's `kb_gates` section. The file belongs to a persona and a bound KB; it is private persona data and never stored in the repository.

| Field | Meaning |
| --- | --- |
| `format_version` | Format version, `1`. |
| `kb` | Name of the bound knowledge base at import time, for example `demo`. |
| `kb_digest_hash` | SHA-256 hex hash of the citable digest of that KB at import time. Reports compare it with the run's `kb.digest_hash`. |
| `imported_at` | ISO timestamp of the import. |
| `cases` | Object keyed by held-out case id. |
| `cases.<id>.coverage` | `C` (the KB covers the question), `P` (it covers part and a person must decide the rest), `N` (it does not cover it), or `X` (excluded from grading). |
| `cases.<id>.entries` | Ids of the verified, unflagged entries that cover the case; `[]` when the import row had none. |

The import file is a JSON object whose `cases` array holds `{id, coverage, entries}` rows; `entries` is optional and other keys are ignored. Import refuses, writes nothing and exits 1 when the persona has no bound KB, a label is not `C`, `P`, `N` or `X`, an id is not a held-out pair of the persona, an id repeats, or an entry id is not a verified, unflagged entry of the bound KB. The message names the one-based row, for example `coverage import: row 2: Duplicate case id.`. A second import replaces the file.

`bunshin coverage show` prints the counts and `kb digest <hash>`, with `· stale` appended when the KB name or digest differs from the bound KB now. A stale file makes the `kb_gates` status `coverage_stale` until you import again.

### Example: `coverage.json`

```json
{
  "format_version": 1,
  "kb": "demo",
  "kb_digest_hash": "6aa2e609f7b5a5bb10967907697ca9097d4f5375a7081a33046bcf8ea691c927",
  "imported_at": "2026-10-20T00:00:00.000Z",
  "cases": {
    "sample-13": {
      "coverage": "C",
      "entries": [
        "demo.model.provider"
      ]
    },
    "sample-10": {
      "coverage": "X",
      "entries": []
    }
  }
}
```

## KB gates: the `kb_gates` report section

When a run has `kb` (a bound persona), `report.json` gains a `kb_gates` object and `report.md` gains the lines below. Reports of unbound runs are unchanged and have no `kb_gates`. `eval report` reads `support.jsonl` (empty when absent) and `coverage.json`, then grades each `spec-answer` draft of the run. Idea-discussion cases are not graded. Grading is a pure function of the run, its drafts, the support rows and the coverage file; it makes no host call.

| Field | Meaning |
| --- | --- |
| `status` | `no_coverage`, `coverage_stale`, `incomplete`, `fail`, or `pass`, checked in this order (see below). |
| `counts` | Cases per outcome: `answered`, `partial`, `abstained`, `wrong_abstain`, `handback_miss`, `over_answer`, `answered_not_covered`, `excluded`, `unlabelled`, `ungraded`. |
| `gate_failures` | Cases that failed each gate: `citation`, `resolves`, `current`, `support`, `coverage`, `scrub`. A case that fails two gates counts once in each. |
| `cases` | One row per graded case: `{id, label, outcome, pass, hard, miss, incomplete}`. |
| `cases[].label` | `C`, `P`, `N`, `X`, or `null` when the case has no label. |
| `cases[].outcome` | One of the outcomes in the table below. |
| `cases[].hard` | Hard-failure gates of the case, in the order `citation`, `resolves`, `current`, `support`, `coverage`, `scrub`. |
| `cases[].miss` | `true` for `wrong_abstain` and `handback_miss`. |
| `cases[].incomplete` | `true` when the case cannot be graded yet. |
| `cases[].pass` | `true` only when the case is not `excluded`, has no hard failure, no miss, and is not incomplete. |

### Outcomes

The outcome comes from the case's coverage label and the draft's `shape`:

| Label | Draft shape | Outcome | Kind |
| --- | --- | --- | --- |
| `C` | `facts` > 0 | `answered` | pass if no hard failure |
| `C` | `facts` = 0 | `wrong_abstain` | miss |
| `P` | `facts` > 0 and `handback` | `partial` | pass if no hard failure |
| `P` | `facts` > 0, no `handback` | `over_answer` | hard failure (`coverage`) |
| `P` | `facts` = 0 | `wrong_abstain` | miss |
| `N` | `abstain`, `facts` = 0 | `abstained` | pass |
| `N` | `handback` only, `facts` = 0 | `handback_miss` | miss |
| `N` | `facts` > 0 | `answered_not_covered` | hard failure (`coverage`) |
| `N` | `facts` = 0, neither `abstain` nor `handback` | `ungraded` | incomplete |
| `X` | any | `excluded` | not counted |
| none | any | `unlabelled` | incomplete |

Hard failures also come from `gates` (`citation`, `resolves`, `current`, `scrub`: a gate that is `false`) and from any support verdict that is `partly` or `not_supported` (`support`). A case is incomplete when its outcome is `ungraded` or `unlabelled`, a draft or its `gates` are missing or malformed, the `support.jsonl` row is missing, a verdict is `support_error`, or, with all four structural gates `true`, the support row has fewer sentences than `shape.facts`. A knowledge case with no draft is `ungraded`. A draft without `shape` (an old run) is `ungraded`.

### Status

`status` is the first that applies:

1. `no_coverage`: the run has no `kb` or `coverage.json` does not exist.
2. `coverage_stale`: `coverage.kb_digest_hash` differs from the run's `kb.digest_hash`.
3. `incomplete`: the run has a `limit`, or any case is incomplete. This outranks `fail`.
4. `fail`: any case has a hard failure.
5. `pass`.

Misses do not change `status`; they appear in the case lines. In `report.md` the status prints in lowercase.

### Example: `kb_gates`

```json
{
  "status": "pass",
  "counts": {
    "answered": 1,
    "partial": 0,
    "abstained": 0,
    "wrong_abstain": 0,
    "handback_miss": 0,
    "over_answer": 0,
    "answered_not_covered": 0,
    "excluded": 0,
    "unlabelled": 0,
    "ungraded": 0
  },
  "gate_failures": {
    "citation": 0,
    "resolves": 0,
    "current": 0,
    "support": 0,
    "coverage": 0,
    "scrub": 0
  },
  "cases": [
    {
      "id": "sample-13",
      "label": "C",
      "outcome": "answered",
      "pass": true,
      "hard": [],
      "miss": false,
      "incomplete": false
    }
  ]
}
```

### Example: `kb_gates` lines in `report.md`

The two lines come after the other report lines. `hard failures <n>` is the sum of the six gate counts. One line follows for each case with a hard failure, a miss or an incomplete state: `- <case id> <label> <outcome>`, then the hard-failure gates. This example labels `sample-13` as `P` while the draft answers without a hand-back:

```text
kb gates: fail · hard failures 1 (citation 0 · resolves 0 · current 0 · support 0 · coverage 1 · scrub 0)
coverage: answered 0 · partial 0 · abstained 0 · wrong abstain 0 · handback miss 0 · over-answer 1 · answered not covered 0 · excluded 0 · unlabelled 0
- sample-13 P over_answer coverage
```

## Reliability report: `evals/reliability/`

`bunshin eval report --runs <a>,<b>[,…]` compares two or more runs of the same inputs to show which cases pass every time. It reads each run's drafts, support rows and judgments with the current `coverage.json`, grades each run as in `kb_gates`, and writes `evals/reliability/<a>+<b>+….json` and `.md` (for example `2026-10-20-01+2026-10-20-02.json`), JSON first and Markdown second. It prints the Markdown. `--runs` cannot be combined with `--run`.

The runs must share every frozen input and the same case ids (the first `limit` cases for a limited run). Otherwise the command exits 1, writes nothing and prints `eval report: runs differ in <field>`, where `<field>` is a `frozen` key or `cases`. An unknown run id prints `eval report: unknown run`. Fewer than two ids, a repeated id, an empty id or `--run` together with `--runs` is a usage error with exit 2.

| Field | Meaning |
| --- | --- |
| `runs` | Compared run ids, in the order given. |
| `frozen` | Inputs that must match in every run: `kb_digest_hash`, `persona_version`, `drafter`, `judge`, `judge_rubric`, `support_rubric`, `judge_examples_hash`, `coverage_hash`. Missing values are `null`. |
| `frozen.coverage_hash` | First 16 hex characters of the SHA-256 hash of the canonical JSON of `coverage.json`. |
| `per_run` | One object per run: `{run_id, kb_gates_status, send_as_is_rate}`. |
| `per_run[].kb_gates_status` | The run's `kb_gates.status`. |
| `per_run[].send_as_is_rate` | Send-as-is judgments divided by valid judgments (not judge errors) as a fraction; `null` when none. |
| `cases` | One row per knowledge-layer case that is not labelled `X`: `{id, label, results, verdict}`. |
| `cases[].results` | One entry per run, `pass`, `fail` or `incomplete`. A run whose status is `no_coverage` or `coverage_stale`, a missing row and an incomplete case all give `incomplete`. |
| `cases[].verdict` | `incomplete` if any result is `incomplete`; otherwise `stable_pass` (all pass), `stable_fail` (all fail) or `unstable` (mixed). |
| `counts` | Cases per verdict: `stable_pass`, `stable_fail`, `unstable`, `incomplete`. |
| `status` | `incomplete` if any case is incomplete or any run's status is `incomplete`, `no_coverage` or `coverage_stale`; otherwise `fail` if any case is `stable_fail` or `unstable`; otherwise `pass`. So `pass` needs every labelled, non-`X` case to be `stable_pass`. |

### Example: `reliability`

```json
{
  "runs": [
    "2026-10-20-01",
    "2026-10-20-02"
  ],
  "frozen": {
    "kb_digest_hash": "6aa2e609f7b5a5bb10967907697ca9097d4f5375a7081a33046bcf8ea691c927",
    "persona_version": 1,
    "drafter": {
      "host": "fake",
      "model": null
    },
    "judge": {
      "host": "fake",
      "model": null
    },
    "judge_rubric": "228729cf56f6ff4c",
    "support_rubric": "e7d793a16fd6b136",
    "judge_examples_hash": null,
    "coverage_hash": "85e5ada023ef3147"
  },
  "per_run": [
    {
      "run_id": "2026-10-20-01",
      "kb_gates_status": "pass",
      "send_as_is_rate": 1
    },
    {
      "run_id": "2026-10-20-02",
      "kb_gates_status": "pass",
      "send_as_is_rate": 1
    }
  ],
  "cases": [
    {
      "id": "sample-13",
      "label": "C",
      "results": [
        "pass",
        "pass"
      ],
      "verdict": "stable_pass"
    }
  ],
  "counts": {
    "stable_pass": 1,
    "stable_fail": 0,
    "unstable": 0,
    "incomplete": 0
  },
  "status": "pass"
}
```

### Example: `reliability` Markdown

```text
bunshin eval reliability — pass
frozen: {"kb_digest_hash":"6aa2e609f7b5a5bb10967907697ca9097d4f5375a7081a33046bcf8ea691c927","persona_version":1,"drafter":{"host":"fake","model":null},"judge":{"host":"fake","model":null},"judge_rubric":"228729cf56f6ff4c","support_rubric":"e7d793a16fd6b136","judge_examples_hash":null,"coverage_hash":"85e5ada023ef3147"}
2026-10-20-01 · pass · send as-is 100%
2026-10-20-02 · pass · send as-is 100%
counts: stable pass 1 · stable fail 0 · unstable 0 · incomplete 0
unstable: none
incomplete: none
```

The last two lines list the case ids of each kind, joined by `, `, or `none`.

## Calibration queue item: `queue.jsonl`

Each line in `calibration/<run_id>/queue.jsonl` selects a draft with a valid judgment. Sampling defaults to 30 items, alternates knowledge and judgment when possible, and stores one seed for the run. An existing queue is never resampled. `calibrate next` shows the question, draft and reference answer without the judge's result.

| Field | Meaning |
| --- | --- |
| `format_version` | Format version, `1`. |
| `run_id` | Eval run date and numeric sequence. |
| `seed` | Sixteen lowercase hex characters from eight random bytes. |
| `position` | One-based queue position. |
| `case_id` | Selected held-out case id. |
| `layer` | Draft layer: `knowledge` or `judgment`. |

### Example: `queue.jsonl`

```json
{"format_version":1,"run_id":"2026-10-20-01","seed":"0123456789abcdef","position":1,"case_id":"sample-10","layer":"judgment"}
```

## Owner rating: `ratings.jsonl`

Each line in `calibration/<run_id>/ratings.jsonl` records an owner rating. Re-rating appends a row; the latest row per case id for this run wins in agreement and reports. Agreement counts only cases with valid judgments, excluding judge errors. Trust uses the same minimum of 30 ratings and the persona's `launch_bar.min_agreement` as the report.

| Field | Meaning |
| --- | --- |
| `case_id` | Rated queue case id. |
| `run_id` | Eval run date and numeric sequence. |
| `rating` | `send_as_is`, `needs_edits`, or `wrong`. |
| `wrong_uncited_fact` | Boolean, present only for knowledge drafts rated `wrong`; `--wrong-uncited-fact yes` or `no` is required for these ratings and refused otherwise. |
| `rated_at` | ISO timestamp when the owner rated the draft. |

### Example: `ratings.jsonl`

```json
{"case_id":"sample-09","run_id":"2026-10-20-01","rating":"wrong","wrong_uncited_fact":true,"rated_at":"2026-10-20T00:00:00.000Z"}
```

## Judge examples: `judge-examples/`

`bunshin examples` keeps the owner's judge examples in `<persona>/judge-examples/`. The files hold the owner's ratings and reasons, so they stay in the persona directory and are never copied into a report. Every example uses a build-split pair; held-out pairs never appear. The examples below use invented ids and text.

| File | Contents |
| --- | --- |
| `set.json` | The pinned 12-item set. Written once by `examples sample`. |
| `examples.jsonl` | One drafted example per set item, positions 1 to 12. |
| `ratings.jsonl` | Owner ratings for set items and extras. Re-rating appends a row. |
| `balance.json` | Marks that balancing started. Written once by `examples balance`. |
| `extras.jsonl` | Extra drafted examples served while balancing, positions 13 and up. |

### `set.json`

| Field | Meaning |
| --- | --- |
| `format_version` | Integer `1`. |
| `seed` | 16 lowercase hex characters that fix the selection. |
| `n` | Number of set items, normally `12`. |
| `pair_ids` | The `n` pair ids in position order. |
| `drafter` | `{host, model}` that drafted the set; `model` may be `null`. |
| `created_at` | ISO timestamp. |

```jsonl
{"format_version":1,"seed":"0123456789abcdef","n":12,"pair_ids":["pair-01","pair-02"],"drafter":{"host":"fake","model":null},"created_at":"2026-10-07T00:00:00.000Z"}
```

(The example shows two ids for brevity; a real `pair_ids` has `n` entries.)

### `examples.jsonl` and `extras.jsonl`

Both files use the same row. `examples.jsonl` rows are the set items. `extras.jsonl` rows are extras drafted on demand while balancing is open; they continue the positions at `n + 1` in the order they were served.

| Field | Meaning |
| --- | --- |
| `pair_id` | Build-split pair id. |
| `position` | Position in the set (1 to `n`) or among the extras (`n + 1` and up). |
| `layer` | `knowledge` or `judgment`. |
| `question` | `{author, text}` of the question. |
| `context` | List of `{author, text}` messages before the question. |
| `reference_answer` | The owner's real answer, shown to the judge as the reference. |
| `draft` | The twin's draft that the owner rated. |
| `drafter` | `{host, model}` that wrote the draft. |
| `drafted_at` | ISO timestamp. |

```jsonl
{"pair_id":"pair-01","position":1,"layer":"judgment","question":{"author":"ann","text":"Should we ship the sample change this week?"},"context":[],"reference_answer":"Yes, ship it.","draft":"Yes, ship it this week.","drafter":{"host":"fake","model":null},"drafted_at":"2026-10-07T00:00:00.000Z"}
```

### `ratings.jsonl`

The latest row per `pair_id` wins.

| Field | Meaning |
| --- | --- |
| `pair_id` | A set item or a drafted extra. |
| `rating` | `send_as_is`, `needs_edits`, or `wrong`. |
| `reason` | Optional. One line of at most 200 characters, stored as written, or `null`. A blank or missing reason counts as no reason. |
| `rated_at` | ISO timestamp. |

```jsonl
{"pair_id":"pair-01","rating":"needs_edits","reason":"Too long for a chat reply.","rated_at":"2026-10-07T00:00:00.000Z"}
```

### `balance.json`

| Field | Meaning |
| --- | --- |
| `format_version` | Integer `1`. |
| `seed` | 16 lowercase hex characters that fix the order of extras. |
| `started_at` | ISO timestamp when balancing started. |

```jsonl
{"format_version":1,"seed":"fedcba9876543210","started_at":"2026-10-07T00:00:00.000Z"}
```

Balancing state is never stored. Phase, counts and the shown set are derived from `set.json`, `examples.jsonl`, `extras.jsonl`, `ratings.jsonl` and `balance.json` each time they are read.

### What the judge sees

Without `balance.json`, the judge sees all `n` set items, each with its latest rating and reason, and `eval run` needs every item drafted and rated.

With `balance.json`, an *N-example* is an item whose latest rating is `needs_edits` with a reason, and an *S-example* is one whose latest rating is `send_as_is` with a reason. Let `k` be the smaller of 6, the number of N-examples and the number of S-examples. The judge sees the first `k` N-examples and the first `k` S-examples, ordered by position (set items first, then extras in the order served). Each keeps its own position. Items rated `wrong`, items without a reason and the surplus are not shown. Extras stop when there are 6 N-examples, when 24 extras are rated or when no eligible build pair remains. A blind pass then asks again for a reason on set items rated `send_as_is` without one, until there are `k` S-examples.

`eval run` refuses while balancing is open (`eval run: judge examples not ready — balancing open (run examples next)`), when `k` is `0` and when the shown examples exceed 60000 characters. Any change to which items are shown, or to their ratings or reasons, changes the examples hash and so resets judge trust to `uncalibrated`.
