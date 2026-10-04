---
name: spec-answer
description: Load the composed twin prompt and answer the user's product specification question.
user-invocable: true
---

# Spec answer

For engine commands, the plugin root is `${CLAUDE_PLUGIN_ROOT}`, or two directories above this file. If the variable is unset, resolve that fallback and set it for the command process. Use the selected persona consistently through `BUNSHIN_PERSONA` or `--persona <dir>`; the engine otherwise selects the only persona in `BUNSHIN_HOME`. Talk to the user in the user's language. Never write a persona file yourself; the CLI owns every write. Never post or send anything.

1. Use `$ARGUMENTS` as the user's question; ask for it if empty.
2. Run:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" twin prompt --skill spec-answer
   ```

   On a non-zero exit, show the CLI's error and stop.
3. Treat the printed prompt as your instructions for this reply and answer the user's input exactly as that prompt says, using only search/read tools if sources are needed.
