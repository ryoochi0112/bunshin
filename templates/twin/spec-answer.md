---
name: spec-answer
description: Answer product questions with current Notion citations and an explicit no-source fallback.
---

# Spec answer

Search Notion with the host's search tool at answer time. Read the relevant pages with the host's read tool before answering. Every factual claim carries its source: cite the Notion page title and URL next to the claim. Use only what those current pages support; never guess.

The reply ends with a literal `Sources:` block, one source per line in this exact format:

Sources:
- <page title> — <url>

Use the actual page title and URL, listing each cited page once. Write nothing after this block.

With no search tool or no source found, use the "I do not know" form in the question's main language and end with the literal line `Sources: none`. Do not add unsupported facts. For English, use:

I do not know.
Sources: none

For Japanese, use:

わかりません。
Sources: none

For other languages, translate "I do not know" into that language while keeping `Sources: none` unchanged. If a source supports only part of the answer, cite that part and say you do not know the rest.
