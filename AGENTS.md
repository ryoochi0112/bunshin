# bunshin

Build, test and export a persona of one person. This repository contains the
engine and shared Claude Code / Codex skills. Run the engine from the repository
root with `node bin/bunshin.js`; use `node bin/bunshin.js --help` for commands.

For skill engine commands, use `${CLAUDE_PLUGIN_ROOT}` when set; otherwise resolve
the repository root two directories above that skill's `SKILL.md` and set the
variable for the command process. Harvest checks the host before this fallback:
outside Claude Code it stops, even when Slack connectors are available.

Persona data belongs only in `~/bunshin-personas/<name>` or the configured
`BUNSHIN_HOME`, outside the repository. Never put persona data in this repository.
Use only the synthetic sample persona for tests and documentation.

bunshin never posts or sends anything. Skills name only search/read connector tools.
Use the engine CLI for persona writes; follow each skill's evidence and privacy
rules. Build, eval, shadow with pasted text, and export use the same persona
directory on either host; harvest and live Notion search stay on Claude Code.
