# Host adapters

The registry in `lib/hosts/index.js` supports `claude` and `fake`. Unknown hosts,
including `codex` until M3, throw before a process starts. No CLI command is added
for hosts; eval and shadow callers use this interface:

```js
const hosts = require('./lib/hosts');
const { host, model } = hosts.parseSpec('claude:haiku');
const reply = await hosts.get(host).run({
  system: composedPrompt,
  prompt: questionAndContext,
  tools: 'notion-read', // or 'none' for the judge
  model,
  allowedTools: hosts.allowedTools(personaJson),
  // outputSchema, timeoutMs, cwd are optional
});
// reply = { text, model, raw }
```

`parseSpec` returns `{ host, model }`; the model is `undefined` for a plain host
name. For `fake:<fixture.json>`, `model` carries the fixture path. The caller
supplies the composed system prompt and only the question plus permitted context
as `prompt`. The adapter never reads persona data or a reference answer.

## Fake host

Plain `fake` returns `I do not know.\nSources: none`. A fixture path is resolved
relative to `process.cwd()`, regardless of the optional `cwd` argument. Its format
is:

```json
{
  "default": "I do not know.\nSources: none",
  "replies": {
    "question substring": "A fictional reply."
  }
}
```

The first matching key in the replies map's insertion order wins; no match uses
`default`. The result is `{ text, model: "fake", raw: { matched } }`, where
`matched` is the key or `null` for the default. `system`, `tools`, `outputSchema`
and `cwd` are accepted and ignored. Fixtures must contain a string default and a
map of string replies. `test/fixtures/hosts/fake-replies.json` is synthetic. This
host performs no model or network call.

## Claude host

Every run starts `claude -p` in a fresh `fs.mkdtemp` directory. Caller-provided
`cwd` is accepted for interface consistency but does not change this isolation.
The only file initially present is `system.md`, written with mode `0600` in the
private temp directory. The question goes to stdin. Neither the question nor the
system text is an argv element. The directory is removed on success or failure.

The exact argument sets (each quoted empty string is one empty argv element) are:

```text
# tools: notion-read
claude -p [--model <model>] --output-format stream-json --verbose
  --setting-sources "" --tools ToolSearch --permission-mode dontAsk
  --allowedTools <allowlist joined by ","> --system-prompt-file <tmp>/system.md

# tools: none
claude -p [--model <model>] --output-format stream-json --verbose
  --setting-sources "" --strict-mcp-config --tools "" --permission-mode dontAsk
  --system-prompt-file <tmp>/system.md
```

`--model` is omitted when none is supplied. `hosts.allowedTools(personaJson)`
reads `hosts.claude.allowed_tools`. A missing value or `[]` uses these defaults
(the sample persona and `init` write `[]` as the placeholder):

- `mcp__claude_ai_Notion__notion-search`
- `mcp__claude_ai_Notion__notion-fetch`

Configured names must be fully qualified `mcp__<server>__<tool>` names without
wildcards, commas or whitespace. Validation rejects any Slack name, the outbound
fragments from `test/skills.test.js` (`send_message`, `schedule_message`,
`send_message_draft`, `add_reaction`, `create_canvas`, `update_canvas`,
`notion-create`, `notion-update`, `notion-move`, `notion-duplicate`), and `create`,
`update`, `delete`, `move`, `upload`, `comment` or `send` anywhere in the tool
part, case-insensitively. The adapter validates `allowedTools` again before
spawning, including for `tools: "none"`. The latter enables no built-in tools and
no MCP connectors; no `--allowedTools` argument is passed.

Child env copies `process.env`, removes **every** variable beginning with
`CLAUDE` or `MCP_`, then adds `MCP_CONNECTION_NONBLOCKING=false`. All other
environment entries are preserved. `--setting-sources ""` prevents the user's
global instructions, hooks and plugins from loading. `--tools ToolSearch` keeps
connector tool discovery available while removing other built-ins.
`--permission-mode dontAsk` denies every tool outside the explicit allowlist.
Slack connector tools can remain listed but cannot run. `--strict-mcp-config`
is used only for `tools: "none"`, since it also removes the Notion connector.
`--bare` is unsuitable for a claude.ai OAuth login because it skips OAuth/keychain
authentication.

`outputSchema`, when supplied, adds `Reply with JSON only matching this schema:`
and the JSON schema to `system.md`. There is no schema CLI flag here and the
adapter does not validate the returned JSON; the caller owns that validation.
The fake host ignores this option.

The adapter parses stream-json lines into `raw` events, returns the final
`result` event's `result` string as `text`, and takes `model` from the
`system`/`init` event. If the CLI omits that model field, `model` is `null` rather
than an inferred name. Intermediate assistant text is never used as the result.
A result with `is_error: true`, a missing result, invalid stream JSON or empty
text rejects. Non-zero exits, launch/stream failures and timeouts also reject
with a message beginning `claude host:`. Diagnostics never include prompt text,
system text, stdout or stderr. Stderr is drained and discarded.

The default timeout is `180000` ms and can be overridden by `timeoutMs` per
call. A timeout sends SIGTERM, then SIGKILL after a one-second grace period if
the child has not closed. Example errors are `claude host: exited with code 1`,
`claude host: timed out after 180 s` and `claude host: empty output`.
Tests inject a spawn function using `require('./lib/hosts/claude').create({ spawn })`;
`make verify` never invokes Claude or another model.

## Measured isolation and connector behavior

Dispatcher measurements, 2026-10-04, Claude Code **2.1.282**, `--model haiku`.
Each probe ran in a fresh `mktemp -d` directory with its prompt on stdin and
`--allowedTools` set to the two default Notion tools. The probe asked the model
to report CLAUDE.md / SessionStart-hook presence and call notion-search,
slack_search_channels and Read. These are supplied measurements, not model runs
performed by the offline test suite.

| run | env | flags | Notion connector at init | Notion search | global CLAUDE.md | SessionStart hook | user plugins | Slack / Read call |
|---|---|---|---|---|---|---|---|---|
| A | inherited (Claude desktop child) | default | absent | NOTOOL | loaded | ran (2) | rstaff, superpowers | n/a |
| B | inherited | --setting-sources "" | absent | NOTOOL | no | no | none | n/a |
| C | inherited | --bare | absent | — | — | — | rstaff, superpowers listed | "Not logged in" (bare skips OAuth/keychain) |
| D | inherited | --setting-sources "" --strict-mcp-config | absent | NOTOOL | no | no | none | n/a |
| E | clean (env -i) | default | connected | OK | loaded | ran (2) | rstaff, superpowers | permission mode "auto" from user settings |
| F | clean | --setting-sources "" | connected | OK | no | no | none | Slack denied, Read denied |
| G | clean | --setting-sources "" --strict-mcp-config | absent (no MCP) | NOTOOL | no | no | none | — |
| H | clean | --bare | — | — | — | — | — | "Not logged in" |
| J | clean + MCP_CONNECTION_NONBLOCKING=true | --setting-sources "" | pending | OK (late) | no | no | none | denied |
| K | inherited minus CLAUDE*/MCP_* | --setting-sources "" | connected | OK | no | no | none | denied |
| L | clean | --setting-sources "" --tools "" --permission-mode dontAsk | connected | FAIL ("Prompt is too long": without ToolSearch all connector schemas load inline) | no | no | none | denied |
| N,O,Q1-3 | scrubbed, nonblocking unset | --setting-sources "" [--tools ToolSearch] --permission-mode dontAsk | pending/absent in 4 of 5 | 1 NOTOOL, 1 FAIL (picked a non-allowed Notion tool) | no | no | none | denied |
| P1-3 | scrubbed + MCP_CONNECTION_NONBLOCKING=false | --setting-sources "" --tools ToolSearch --permission-mode dontAsk | connected 3/3 | OK 3/3 | no | no | none | Slack denied 3/3; no Read tool |
| R | scrubbed + nonblocking=false | --setting-sources "" --strict-mcp-config --tools "" --permission-mode dontAsk --system-prompt-file | absent (no MCP) | NOTOOL (as intended for tools:none) | no | no | none | system prompt file honoured |
| S | same as R without --strict-mcp-config | | connected | — | | | | "Prompt is too long" (~647k tokens of connector schemas) |

Findings:

1. Inside a Claude Code session the child inherits `CLAUDE_CODE_*` and
   `MCP_CONNECTION_NONBLOCKING=true`; connectors are then not ready when the turn
   starts. Scrubbing `CLAUDE*`/`MCP_*` and forcing
   `MCP_CONNECTION_NONBLOCKING=false` made the Notion connector connected at init
   3/3.
2. `--allowedTools` only pre-approves; `--permission-mode dontAsk` denies every
   other tool, and `--tools ToolSearch` removes all other built-ins (Read, Bash,
   Write, WebFetch...). Slack tools stay *listed* (the claude.ai connectors cannot
   be filtered per server without `--strict-mcp-config`) but every call is denied.
3. `--bare` cannot be used with an OAuth (claude.ai) login.
4. `tools: "none"` needs `--strict-mcp-config`, else the connector schemas
   overflow the context.
5. Once, the model called `notion-ai-search` (not allowed) instead of
   `notion-search`; the denial is safe. This is a known prompt-side issue for T3:
   request the explicitly allowed notion-search and notion-fetch capabilities.
