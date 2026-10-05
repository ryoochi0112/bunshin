---
name: calibrate
description: Let the owner rate blinded twin drafts and report judge agreement.
user-invocable: true
---

# Calibrate

For engine commands, the plugin root is `${CLAUDE_PLUGIN_ROOT}`, or two directories above this file. If the variable is unset, resolve that fallback and set it for the command process. Use the selected persona consistently through `BUNSHIN_PERSONA` or `--persona <dir>`; otherwise the engine selects the only persona in `BUNSHIN_HOME`. Talk to the user in the user's language. Never write a persona file yourself; the CLI owns every write. Never post or send anything.

Never read `judgments.jsonl`. Never reveal or guess the judge's rating, never suggest a rating, and never add or paraphrase judge reasons beyond what the CLI output shows. The owner chooses every rating. The owner may stop at any time; running the skill again continues at the next unrated item.

1. Start with:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" calibrate sample
   ```

   Append `--run <run_id>` and/or `--n <n>` only when the user named them. Append `--persona <dir>` when the selected persona uses that flag. Capture the run id from the CLI output for the remaining commands. If the output says `queued 0 items` or `queue exists for <run_id> (0 items)`, stop and tell the owner to finish an eval run that produces valid judgments before sampling again.

2. Repeat the following until `calibrate next` prints `all <k> items rated — run calibrate score`:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" calibrate next --run <run_id>
   ```

   Append `--persona <dir>` when the selected persona uses that flag. Show the CLI item output as printed, one item at a time, then ask exactly:

   `A) send as-is  B) needs edits  C) wrong`

   Map the owner's choice A/B/C to `send_as_is`/`needs_edits`/`wrong`. For a knowledge item rated C, also ask exactly `Did the draft state a wrong fact without a citation? A) yes  B) no`; map the answer to `--wrong-uncited-fact yes` or `--wrong-uncited-fact no`.

   Record only the owner's choice:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" calibrate rate <case_id> <rating> --run <run_id>
   ```

   For a knowledge item rated `wrong`, put `--wrong-uncited-fact yes|no` after `<rating>`. Append `--persona <dir>` when the selected persona uses that flag. If the owner stops, stop without rating the current item. On any non-zero exit, show the CLI error as-is and stop.

3. After `calibrate next` prints that all items are rated, run:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" calibrate score --run <run_id>
   ```

   Append `--persona <dir>` when the selected persona uses that flag, and print the score line as-is.
