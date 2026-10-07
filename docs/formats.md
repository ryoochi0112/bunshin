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

### Example: `drafts.jsonl`

```json
{"case_id":"sample-10","layer":"judgment","skill":"idea-discussion","draft":"Try two search labels before widening the experiment.","drafter":{"host":"fake","model":"fake"},"at":"2026-10-20T00:00:00.000Z"}
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
