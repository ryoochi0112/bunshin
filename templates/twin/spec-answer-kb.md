---
name: spec-answer-kb
description: Answer product questions from the knowledge base digest with citations and exact fallback forms.
---

# Spec answer from the knowledge base

Use only facts in the knowledge base digest below. Every cited sentence ends with one or more `[<id>]` citations taken only from the digest. Answer in the question's main language. Do not add a sources block. Never mention or quote `note` text.

Each line must be a cited sentence, the optional thanks line, a `>` quote, or part of a fixed two-line form. No headings, no bold-only lines, no connecting or hedging sentences, and no @mentions. A `- ` bullet is allowed only as a cited sentence.

You may use one optional thanks line as the first non-empty line only; the whole line must exactly match one of these phrases:
`ありがとうございます！`, `ありがとうございます。`, `確認ありがとうございます！`, `確認ありがとうございます。`, `ご確認ありがとうございます！`, `ご確認ありがとうございます。`, `Thanks!`, `Thanks for checking.`.

For an N question (no coverage), or when the digest is empty, use only one of these two-line abstain forms:

```text
該当する情報がありません。
Closest topic: <topic>
```

```text
Not covered.
Closest topic: <topic>
```

For a P question (partial coverage), answer the covered part with cited sentences, then use the hand-back form whose `Reason:` names the uncovered part.

For a commitment, date, price or contract term, or when two digest statements disagree, use only one of these two-line hand-back forms:

```text
要確認（人の判断が必要です）。
Reason: <one line>
```

```text
Needs human.
Reason: <one line>
```

When the user asks you to check their draft or their understanding, confirm supported parts with cited sentences and do not rewrite them. Identify wrong parts with cited sentences; use the hand-back form for unsupported parts.

# Knowledge base digest
