# Codex

bunshin's repository root is a Codex plugin: `.codex-plugin/plugin.json`
packages the shared `skills/`. Build, eval, shadow with pasted text, and export
use the same private persona directory as Claude Code. Persona data stays outside
the plugin and repository, in `~/bunshin-personas/<name>` or `BUNSHIN_HOME`.

## Install a local plugin

The M3 installation measurement (2026-10-04, codex-cli 0.159.0) used a personal
marketplace at `~/.agents/plugins/marketplace.json` and local plugin sources under
`~/.agents/plugins/plugins/`. Copy a clone there:

```sh
mkdir -p ~/.agents/plugins/plugins
cp -R /absolute/path/to/bunshin ~/.agents/plugins/plugins/bunshin
```

Add this entry to the existing marketplace's `plugins` array; preserve other
entries. If there is no marketplace, create one with this content:

```json
{
  "name": "personal",
  "interface": { "displayName": "Personal plugins" },
  "plugins": [
    {
      "name": "bunshin",
      "source": {
        "source": "local",
        "path": "./.agents/plugins/plugins/bunshin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

The source path is relative to the personal marketplace root (your home), not
the directory containing the JSON file. Restart the desktop app, open the
Plugins Directory, choose the personal source and install bunshin. See
[OpenAI's local plugin instructions](https://developers.openai.com/plugins/build/plugins)
for marketplace format and installation. Installation discovery is recorded
above; this change has not measured installation or a full online run.

## Commands

Select the same persona with `BUNSHIN_PERSONA` or `--persona <dir>` on either
host. Run CLI examples from the plugin/repository root. Shared skills resolve
`CLAUDE_PLUGIN_ROOT` when set, otherwise the root two directories above their
`SKILL.md`.

| Operation | Codex support |
| --- | --- |
| Build | Follow the build skill in a fresh session; commit through `identity commit` and run `check`. |
| Interview, diagnose, calibration | Shared skills and CLI; resolve conflicts before building. |
| Eval | `eval run --drafter codex --judge claude`, or reverse the hosts; `eval report` names the models. |
| Shadow | Pasted text via `shadow new --question-file <file>`; `shadow draft <id> --drafter codex`; `shadow show <id>`. |
| Export | `export` writes the standalone Claude Code persona package. Loading that package in Codex has not been measured. |
| Spec answer | No reachable live source on the Codex adapter; answer `I do not know.` with `Sources: none`. |
| Examples | `examples sample --drafter codex`; rating runs on either host. |
| Idea discussion | Uses evidenced persona priorities. |
| Harvest and live Notion search | Stay on Claude Code; harvest stops on Codex even if connectors are available. |

Cross-host eval on the synthetic sample:

```sh
node bin/bunshin.js eval run --drafter codex --judge claude --limit 2
node bin/bunshin.js eval report
node bin/bunshin.js eval run --drafter claude --judge codex --limit 2
node bin/bunshin.js check
```

Use `codex:<model>` to select a Codex model. Both CLIs need authentication and
available quota for these examples.

Every `codex exec` bunshin starts removes connectors, including Slack, Notion
and user MCP servers, and ignores user configuration and rules. Eval and shadow
adapter calls additionally remove shell and web tools and run read-only in an
empty temporary directory. The online build acceptance uses a separate agent
with shell access in a temporary sample workspace. See
[host isolation measurements and remaining tools](hosts.md), measured
2026-10-05; connector removal is required even with a read-only sandbox.
bunshin never posts or sends anything.

## Online acceptance

```sh
make acceptance-codex
```

This is separate from `make verify`. It requires working Codex and Claude Code
CLIs, network access and quota. It checks six outcomes: build-skill identity
commit, both cross-host eval directions, pasted-text shadow, export with green
checks, and a no-source spec answer. Both hosts use one temporary synthetic
sample persona. Each check prints PASS or FAIL; any failure exits nonzero.
Unavailable hosts, quota exhaustion and failed assertions are failures, not
skips. A detected Codex launch failure says "codex unavailable / over quota"
and identifies the launch problem. Host adapters suppress model diagnostics, so
a nonzero exit with no reported cause asks the operator to check authentication,
quota and flags. Assertion failures state the failed outcome without guessing
a host or quota cause.

For the build check only, the runner copies the engine and build skill into a
temporary workspace and sets temporary `HOME`, `TMPDIR` and `BUNSHIN_HOME`.
The runner never reads or copies credentials. It passes the real `CODEX_HOME`
through an environment allowlist (default `~/.codex`), outside the writable
workspace. `--ignore-user-config` prevents loading user configuration and
`--ephemeral` prevents session rollouts. The child uses `-s workspace-write`
with no extra writable directories and the default `/tmp` and `TMPDIR` write
allowances disabled ([configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
It ignores user rules, removes connectors and web, and receives instructions to
use only the sample and permitted evidence.

`workspace-write` restricts writes, not reads: this shell-enabled build agent can
read outside its temporary workspace, including the real Codex credential home.
Using only the sample is an instruction, not an enforced read boundary. The
runner validates committed files and CLI results, then removes the workspace.
SIGINT, SIGTERM and SIGHUP kill active child process groups, remove the temporary
workspace and exit nonzero. That build invocation's online behavior has not
been measured here.

This change was verified offline. Online Codex acceptance has **not been run**;
run it before claiming the Codex path is accepted.
