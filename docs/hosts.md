# Host adapters

The registry in `lib/hosts/index.js` supports `claude`, `codex` and `fake`. Unknown
hosts throw before a process starts. No CLI command is added for hosts; eval and
shadow callers use this interface:

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
name. `codex:<model>` passes the model to Codex as `-m <model>`. For `fake:<fixture.json>`, `model` carries the fixture path. The caller
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

Configured names must be exactly `mcp__<server>__notion-search` or
`mcp__<server>__notion-fetch`. The server name contains only letters A–Z or a–z,
digits, underscores and hyphens, is non-empty, and contains no `__`. It must
contain `notion` and must not contain `slack`, both checked case-insensitively.
The tool part is case-sensitive: only `notion-search` and `notion-fetch` pass.
Null, non-array values, non-string entries and all other tool names are refused.
This positive allowlist implements contract §6: the drafter has only Notion
search and fetch tools. The adapter validates `allowedTools` again before
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
6. Acceptance check 6 proves "no user context" from the init event (only builtin plugins, no namespaced slash commands or skills); a missing global CLAUDE.md cannot be observed in any event, so it rests on `--setting-sources ""` alone.

## Codex host

Every run starts `codex exec` in a fresh `fs.mkdtemp` directory. The child's
working directory is an empty `work/` subdirectory. Caller-provided `cwd` is
accepted for interface consistency but does not change this isolation. The
system text is written to `system.md` (mode `0600`) next to `work/`, and Codex
loads it through the `model_instructions_file` config key. It replaces the Codex
base instructions. The question goes to stdin. Neither the question nor the
system text is an argv element. The directory is removed on success or failure.

The exact argument set is the same for `tools: "notion-read"` and
`tools: "none"`:

```text
codex exec -s read-only --skip-git-repo-check --ephemeral --strict-config
  --ignore-user-config --ignore-rules
  --disable apps --disable plugins --disable remote_plugin
  --disable shell_tool --disable unified_exec --disable view_image
  --disable image_generation --disable goals --disable sleep_tool
  --disable multi_agent -c web_search="disabled"
  -C <tmp>/work --color never
  -c model_instructions_file="<tmp>/system.md"
  -o <tmp>/last-message.txt
  [-m <model>] [--output-schema <tmp>/schema.json] -
```

- `-s read-only` is always present, exactly once. No argument widens it: no
  `--sandbox` override, no `--add-dir`, no `--dangerously-bypass-*`, no
  `--approve-for-me`, no `--enable`, no profile. The `-c` overrides are an exact
  allowlist: `web_search="disabled"` and `model_instructions_file`. A model
  starting with `-` is refused, so it cannot become a flag.
- `--ignore-user-config --ignore-rules --disable apps --disable plugins
  --disable remote_plugin` is the **connector-removal flag set**. It is always
  present for every `tools` value (measured below). Codex exits with an error on
  an unknown feature name, so a renamed feature fails closed instead of running
  with connectors.
- `--disable shell_tool --disable unified_exec --disable view_image
  --disable image_generation --disable goals --disable sleep_tool
  --disable multi_agent -c web_search="disabled"` is the **tool-removal flag set**,
  also always present. It removes the shell, image, goal, sleep and web-search
  tools, and the deferred multi-agent tools on models without code mode (measured
  below).
  The read-only sandbox limits writes and network, not reads, so without this set
  the shell could read any file, including held-out reference answers. This makes
  blinding mechanical for the drafter and gives the judge no shell, file, web or
  image tool.
- `--strict-config` makes Codex exit on an unknown `-c` key, so a renamed key fails
  closed. An invalid `web_search` value also exits non-zero (measured).
- `--ephemeral` keeps the prompt out of `~/.codex/sessions`.
- With `outputSchema`, the schema is written to `schema.json` (mode `0600`) and
  passed with `--output-schema`. The caller still validates the reply.

**No connector allowlist.** Codex gets no connector allowlist from bunshin, and
`allowedTools` (a Claude setting) is ignored. With connectors removed,
`tools: "notion-read"` on Codex has no reachable source. A spec question
therefore gets the "I do not know" answer (criterion 6). Live Notion search stays
on Claude Code.

**Child env.** The child gets an allowlist, not a copy of `process.env`: `PATH`,
`HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE` and `CODEX_HOME`, each only when
set. No `BUNSHIN_*` variable reaches Codex, so nothing in the env points at persona
data. Codex ChatGPT-login auth works with only `PATH`, `HOME`, `TMPDIR` and `LANG`
(measured).

**Result.** `text` is the exact content of the `-o` last-message file. `model` is
the `model:` line of the banner that `codex exec` prints on stderr between the
first two `--------` lines; it is `null` when the banner has no `model:` line. The
`--json` event stream does not contain the model name (measured), which is why
the adapter uses the plain output mode. `raw` is `{ header }`, the parsed banner
fields. Everything on stderr after the banner can echo the
prompt and is drained and discarded. stdout is drained and discarded.

**Failures** behave like the Claude host, with messages beginning `codex host:`.
A non-zero exit, a signal, launch or stream failures, a missing or blank
last-message file (`codex host: empty output`) and a timeout reject. The default
timeout is `180000` ms; SIGTERM is followed by SIGKILL after one second. If the
banner reports a sandbox other than `read-only`, the run rejects with
`codex host: sandbox is not read-only`. If the banner or its `sandbox:` line is
missing, the run rejects with `codex host: sandbox not reported`. Diagnostics
never include prompt text, system text, stdout or stderr.
Tests inject a spawn function using `require('./lib/hosts/codex').create({ spawn })`.

## Measured Codex connectors

Measured 2026-10-05, `codex-cli 0.159.0` at `/opt/homebrew/bin/codex`, default
model `gpt-6.1-sol`. Each probe ran in a fresh `mktemp -d` directory outside the
repository, with the prompt on stdin. Probes only called discovery tools
(`list_mcp_resources`, `list_mcp_resource_templates`, and the code-mode
`ALL_TOOLS` name list). They read no Slack message or Notion page, posted
nothing and installed nothing. The evidence is the raw `--json` output and the
session rollout file `~/.codex/sessions/.../rollout-*.jsonl` (the
`custom_tool_call_output` of `text(ALL_TOOLS.map(x=>x.name).join("\n"))`), not
the model's own summary.

```text
# A (before)
codex exec -s read-only --skip-git-repo-check --json - < probe.txt
# B (after)
codex exec -s read-only --skip-git-repo-check --ignore-user-config --ignore-rules \
  --disable apps --disable plugins --disable remote_plugin --json - < probe.txt
```

| probe | flags | callable tools | `mcp__codex_apps__*` | Slack tools | Notion tools | `list_mcp_resources` |
|---|---|---|---|---|---|---|
| A | none beyond `-s read-only --skip-git-repo-check` | 345 | 328 (Slack, Notion, Google Drive, GitHub, Datadog, Sites, ChatGPT space, plugin management...) | 38, incl. `slack_send_message`, `slack_schedule_message`, `slack_delete_message` | 37, incl. `notion_update_page`, `notion_create_pages` | present; resources from server `codex_apps` |
| B | connector-removal flag set | 10 | 0 | 0 | 0 | absent |
| D | final adapter argv without `--ephemeral` plus `model_instructions_file` | 10 (same as B) | 0 | 0 | 0 | absent |

Raw evidence lines:

- A, `--json` stdout: `"server":"codex","tool":"list_mcp_resources"` returned
  `{"resources":[{"server":"codex_apps",...` (`codex_apps` appears 380 times,
  `Slack` 3, `Notion` 6). The rollout tool list contains
  `mcp__codex_apps__slack_slack_send_message`,
  `mcp__codex_apps__notion_notion_update_page`, and `mcp__node_repl__js` (a user
  MCP server from `config.toml`).
- B, `--json` stdout: 0 matches for `Slack`, `slack`, `Notion`, `notion`,
  `codex_apps`. The rollout tool list is exactly `apply_patch clock__curr_time
  create_goal exec_command get_goal image_gen__imagegen update_goal view_image
  web__run write_stdin`. The remaining rollout mentions of "Slack"/"Notion" are
  base-instruction prose, one user skill description and the probe prompt itself.
- D: `base_instructions` in the rollout is the synthetic system file
  (`"provenance":{"type":"custom"}`), and the reply followed it. No
  `~/.codex/AGENTS.md` content was loaded.
- C and E (final argv with `--ephemeral`): stderr banner
  `model: gpt-6.1-sol` and `sandbox: read-only`; no rollout file was written.
  E used `--output-schema` with the real judge schema, and `judge.parse`
  accepted the reply.

The connector-removal set alone left the built-in shell, web search and image
tools. The next section removes them.

## Measured Codex built-in tools

Measured 2026-10-05, `codex-cli 0.159.0`, from a scratch directory outside the
repository. Two methods were used; neither relies on the model's own summary.

1. **Local mock provider (no model call).** A local HTTP server stood in for the
   Responses API (`-c model_providers.mock={...} -c model_provider=mock`). It
   served the cached model metadata for `gpt-6.1-sol` and recorded each request
   body, which holds the exact tool list sent to the model. A scripted reply then
   called the code-mode `exec` tool with
   `ALL_TOOLS`, `tools.apply_patch(...)` and `tools.exec_command({cmd: "cat <file>"})`
   against a synthetic canary file outside the working directory.
2. **Real runs (3 small probes).** The probe asked the model to run
   `text(ALL_TOOLS.map(x=>x.name).join(","))` in `exec`. The evidence is the
   `custom_tool_call_output` in the rollout file (the probe ran without
   `--ephemeral`; the probe rollouts were deleted afterwards). All ran under
   `env -i PATH HOME TMPDIR LANG`.

| probe | flags | nested tools (`ALL_TOOLS`) | canary read via shell |
|---|---|---|---|
| attempt-1 set, real (from the connector section) | connector removal only | `apply_patch clock__curr_time create_goal exec_command get_goal image_gen__imagegen update_goal view_image web__run write_stdin` | — |
| mock, attempt-1 set | connector removal only | `apply_patch clock__curr_time create_goal exec_command get_goal update_goal view_image write_stdin` | **yes**: `exec_command` returned the canary text under `-s read-only` |
| real, tool removal without `web_search` | final set minus `-c web_search="disabled"` | `apply_patch clock__curr_time web__run` | — |
| real, final set | final adapter flag set | `apply_patch clock__curr_time` | — |
| mock, final set | final adapter flag set | `apply_patch clock__curr_time` | **no**: `tools.exec_command is not a function` |

The mock does not show `web__run` or `image_gen__imagegen`; they appear only with
the real OpenAI provider. The real runs therefore prove the web and image
removal. The real final run reported `model: gpt-6.1-sol` and
`sandbox: read-only` in the banner, and the filtered env authenticated.

Remaining tools with the final set, and why they stay:

- `exec` (code mode) runs JavaScript in a V8 isolate. Its nested tools are only
  the ones listed above (measured). That the isolate itself has no file system
  or network is not directly measured; it rests on the Codex tool description.
- `clock__curr_time` returns the current time.
- `request_user_input`, `request_user_input_async` and `wait`.
- The `collaboration` sub-agent tools on code-mode models. They cannot be
  removed in 0.159.0, and a spawned sub-agent gets the same removed tool list
  (measured; see the next section).
- `apply_patch` cannot be removed in 0.159.0: no feature or config key controls
  it; it comes from the model metadata (`apply_patch_tool_type`). Writes are
  blocked: a matching patch returned `patch rejected: writing is blocked by
  read-only sandbox` and the file stayed unchanged. Before rejecting, Codex
  verifies the patch against the file. A non-matching patch returned
  `Failed to find expected lines in <path>:` followed by the model's own lines,
  never file content. This is a residual whole-line existence oracle. The model
  can confirm a line only if it already guessed the whole line exactly.
- The skill list from `~/.codex/skills` (names and descriptions) stays in
  context. No tool remains that could read a skill file.

## Measured Codex sub-agents

Measured 2026-10-05, `codex-cli 0.159.0`, with the local mock provider described
above (no model call). Every run used the full adapter argv (same flags,
`--ephemeral`, `-s read-only`, `env -i PATH HOME TMPDIR LANG`) plus the two mock
provider `-c` keys. The mock recorded the body of each `/v1/responses` request.
The evidence is the tool list in that body (`tools` plus the `additional_tools`
input item), not a tool description.

`codex features list` shows `multi_agent stable true` and
`multi_agent_v2 stable false`. The model metadata decides which tools appear:
`gpt-6.1-sol`, `gpt-6-astra` and most current models have
`tool_mode: "code_mode_only"` and `multi_agent_version: "v2"`; `gpt-5.5` has no
code mode.

Top-level tool list per request (`top:` = `tools` field, `ns/name` = an
`additional_tools` namespace; nested `exec` tools in brackets):

| model | flags | tool list |
|---|---|---|
| `gpt-6.1-sol` | final set without `--disable multi_agent` | `functions/exec functions/wait functions/request_user_input functions/request_user_input_async collaboration/followup_task collaboration/interrupt_agent collaboration/list_agents collaboration/send_message collaboration/spawn_agent collaboration/wait_agent` [`apply_patch clock__curr_time`] |
| `gpt-6.1-sol` | final set | identical to the row above |
| `gpt-6.1-sol` | final set plus `--disable multi_agent_v2`, or `-c features.multi_agent_v2.enabled=false`, or `-c agents.max_depth=0` | identical to the row above |
| `gpt-5.5` | final set without `--disable multi_agent` | `top:request_user_input top:apply_patch top:tool_search`; `tool_search` lists "Multi-agent tools: Spawn and manage sub-agents" as a deferred source |
| `gpt-5.5` | final set | `top:request_user_input top:apply_patch` |
| `gpt-5.6-luna`, `gpt-reserve`, `codex-auto-review` | either | `functions/exec functions/wait functions/request_user_input` [`apply_patch`] |

So `--disable multi_agent` is kept because it removes `tool_search` and its
deferred multi-agent tools on `gpt-5.5`. No measured flag or config key removes
the `collaboration` tools on code-mode models; they come from the model
metadata. `-c agents.max_threads=0` exits with an error, and
`agents.max_depth=0` still allowed a spawn.

**Spawned sub-agent.** A scripted mock reply called `collaboration/spawn_agent`
(`fork_turns: "none"`), then `wait_agent`. The mock answered the sub-agent's
first request with an `exec` call that ran `ALL_TOOLS` and
`tools.exec_command({cmd: "cat <canary file outside work/>"})`.

| run | sub-agent model | sub-agent tool list | `exec` result |
|---|---|---|---|
| final set (also without `--disable multi_agent`) | `gpt-6.1-sol` (inherited) | `functions/exec functions/wait functions/request_user_input collaboration/followup_task collaboration/interrupt_agent collaboration/list_agents collaboration/send_message collaboration/spawn_agent collaboration/wait_agent` [`apply_patch clock__curr_time`] | `SUB_ALL_TOOLS=apply_patch,clock__curr_time`, `SUB_EXEC_ERR=TypeError: tools.exec_command is not a function` |
| final set (also without `--disable multi_agent`), `model: "gpt-6-astra"` override | `gpt-6-astra` | same as above | same as above |
| final set (also without `--disable multi_agent`), `model: "gpt-5.5"` override | `gpt-5.5` | `top:request_user_input top:apply_patch` | `unsupported custom tool call: exec` |

The sub-agent therefore runs with the same removal as the parent; no shell
returned, and the canary was not read. With `fork_turns` `"all"` or `"3"`,
the spawn itself failed (`collab spawn failed: ... no rollout found for thread
id ...`) because `--ephemeral` writes no rollout. Only one spawn level was
measured; a sub-agent's own sub-agent is assumed to inherit the same way.

