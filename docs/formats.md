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
{"id":"sample-10","layer":"judgment","question":{"author":"Neri Moss","text":"Should the search experiment replace the whole navigation?"},"context":[{"author":"Sora Aoki","text":"This is a fictional Tidepool design discussion in a sandbox."}],"reference_answer":"Keep navigation steady while comparing two search labels on the sandbox board. Measure successful lookups, then decide whether a navigation experiment is warranted.","permalink":"https://example.invalid/tidepool/threads/sample-10"}
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
