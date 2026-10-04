---
name: export
description: Export a leak-checked persona package and explain how to load its skills.
user-invocable: true
---

# Export

For engine commands, the plugin root is `${CLAUDE_PLUGIN_ROOT}`, or two directories above this file. Use the selected persona consistently through `BUNSHIN_PERSONA` or `--persona <dir>`; otherwise the engine selects the only persona in `BUNSHIN_HOME`. Talk to the user in the user's language. Never write a persona file yourself; the CLI owns every write. Never post or send anything.

Read `$ARGUMENTS` for a named `--out <dir>`. Run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/bunshin.js" export
```

Append `--out <dir>` only when the user named it. Append `--persona <dir>` when the selected persona uses that flag. On any non-zero exit, show the CLI error as-is and stop.

On success, use the printed `files` paths to find the one ending in `.claude-plugin/plugin.json`. The package path is the directory two levels above that file; print that path. Give the owner these two load instructions verbatim: `claude --plugin-dir <path>`, or copy `<path>/skills/*` into `~/.claude/skills/`. The skill does not copy files or install the package itself.
