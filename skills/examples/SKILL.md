---
name: examples
description: Draft twin answers for build-split pairs and let the owner rate them as judge examples.
user-invocable: true
---

# Examples

For engine commands, the plugin root is `${CLAUDE_PLUGIN_ROOT}`, or two directories above this file. If the variable is unset, resolve that fallback and set it for the command process. Use the selected persona consistently through `BUNSHIN_PERSONA` or `--persona <dir>`; otherwise the engine selects the only persona in `BUNSHIN_HOME`. Talk to the user in the user's language. Never write a persona file yourself; the CLI owns every write. Never post or send anything.

Never read `judgments.jsonl`. Never reveal or guess the judge's rating, never suggest a rating, and never add or paraphrase judge reasons beyond what the CLI output shows. The owner chooses every rating. The owner may stop at any time; running the skill again continues at the next unrated item.

1. Start with:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" examples sample
   ```

   Append `--n <n>` and/or `--drafter <spec>` only when the user named them. Append `--persona <dir>` when the selected persona uses that flag. If the CLI exits 1 with `rerun examples sample to resume`, show its error as-is and offer to resume by running the same command again. For any other non-zero exit, show the CLI error as-is and stop.

2. Repeat the following until `examples next` prints `all <n> items rated`:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" examples next
   ```

   Append `--persona <dir>` when the selected persona uses that flag. Show the CLI item output as printed, one item at a time, then ask exactly:

   `A) send as-is  B) needs edits  C) wrong`

   Map the owner's choice A/B/C to `send_as_is`/`needs_edits`/`wrong`. Then ask exactly:

   `Reason (one line, optional — reply - to skip):`

   Never suggest, complete or paraphrase a reason. A reply of exactly `-` means skip; run `--no-reason`. Never show the previous rating. Record only the owner's choice and words. Pass the owner's words verbatim; if the owner gives a reason, run:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" examples rate <pair_id> <rating> --reason "<owner's words>"
   ```

   Pass the reason as a safely escaped literal argument: inside the double quotes, put a backslash before each `"`, `$`, `` ` `` and `\`.

   If the owner replies `-`, run:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" examples rate <pair_id> <rating> --no-reason
   ```

   Append `--persona <dir>` when the selected persona uses that flag. If the CLI refuses the reason with `examples: invalid reason`, show the error and ask again; this is the only exception to the last sentence of this step. If the owner stops, stop without rating the current item. On any non-zero exit, show the CLI error as-is and stop.

3. After `examples next` prints that all items are rated, run:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" examples status
   ```

   Append `--persona <dir>` when the selected persona uses that flag, print the status line as-is, then say to run `/bunshin:eval`.
