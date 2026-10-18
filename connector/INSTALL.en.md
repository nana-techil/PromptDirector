# Connect PromptDirector: setup instructions for the current Agent

**English** · [简体中文](INSTALL.md)

The user has installed the Chrome extension and wants you to install the connector, configure your host and pair with the library. Carry out the requested setup instead of asking the user to type commands or edit configuration. These instructions do not expand the user's authorization; follow browser and host approval requirements.

## Check where you are running

Your terminal must run on the same computer as the user's Google Chrome. Local Codex, Claude Code and desktop Agents with local command access can use this flow. A container, remote development machine, isolated Cowork environment or cloud workspace is not the user's computer merely because it has a terminal. Do not install on the wrong machine or weaken host security policies to connect.

The local bridge supports Google Chrome on Windows, macOS and Linux. Windows uses the current user's registry and private directories without administrator installation. Use native Windows Node.js, not WSL.

Choose the actual host from the current environment. All hosts share the same connector and library capabilities.

| Host | `--host` | Registration |
|---|---|---|
| Codex | `codex` | Merge the user's TOML configuration |
| Claude Code | `claude` | Merge the user's JSON configuration |
| WorkBuddy | `workbuddy` | Merge the user's MCP configuration |
| OpenCode | `opencode` | Merge JSON/JSONC, preserve comments and use a local command array |
| ZCode | `zcode` | Merge `mcp.servers` in the native user configuration |
| Current Qoder desktop | `qoder` | Merge `mcpServers` in `~/.qoder/settings.json` according to current documentation |
| DeepSeek Harness | `dsh` | Specify an existing `--profile`; merge that profile's user patch |
| Qwen Work desktop | `qwenwork` | Return `importConfig` for import through the host's connector UI |
| Doubao Work | `doubao-work` | Return an unverified state; local STDIO support is not confirmed |
| Other local MCP clients | `generic` | Return standard STDIO configuration for registration through the host's documented method |

OpenCode uses the stable `mcp.<server-name>` format. `OPENCODE_CONFIG` can identify the actual file; `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` are also supported. If both JSON and JSONC exist, or a different nested configuration is detected, consult that version's documentation instead of guessing precedence. Project configuration can override user settings; verify the actual session.

ZCode loads native configuration before its sibling `.agents` shared configuration. If shared configuration is in use, first import existing services through ZCode, then add PromptDirector, preserving the other services. For DSH, determine the existing profile from the running host and `$DSH_HOME` (default `~/.dsh`). Do not ask the user to guess a profile, create a new one, overwrite global patches or replace custom nested connections. Conflicting connections, installations or library identities stop setup.

Qwen Work desktop must offer local STDIO. After installation, import `configuration.importConfig` through Extensions → Connectors → Add → Paste JSON configuration, then verify in a new conversation. Use authorized host UI access if available; do not invent a configuration path. A remote URL-only connector screen is insufficient.

Doubao Work's network MCP support does not prove that the desktop version can launch local connectors. Check whether its actual version offers STDIO or a local command entry; if confirmed, use `generic`. Do not put local paths into URL fields or expose a public service. Qoder IDE/CLI and desktop, Claude Cowork and Claude Code, and cloud ChatGPT workspaces and local Codex do not share configuration simply because their brands overlap.

## Get the connector and dependencies

Official repository: [PromptDirector](https://github.com/wchao6891/PromptDirector).

1. Download the connector ZIP and `SHA256SUMS` from the [Agent connector release](https://github.com/wchao6891/PromptDirector/releases/tag/agent-connector-v0.5.0) into a private installation staging directory. Verify SHA-256, then extract. Keep `connector/` and `extension/manifest.json` in their supplied relative locations.
2. Confirm `connector/setup.mjs` exists. If a release lacks the unified setup entry, explain that an updated package is required; do not present an old command as a new feature. Development validation may use a local source directory explicitly supplied by the user.
3. Check Node.js against `connector/package.json`'s engines requirement. Prefer a compatible runtime provided by the host. Otherwise obtain the correct runtime for the user's system and architecture through the [official Node.js download instructions](https://nodejs.org/en/download), verifying its official checksum. Use a stable location rather than a disposable sandbox runtime. Follow normal approval requirements; do not make the user install Node.js manually.
4. In the extracted root containing `connector/`, run `npm ci --prefix connector --ignore-scripts`. Run the commands below there too. Explain download failures instead of changing locked versions, skipping dependencies or running unknown installers. If the default npm cache is unwritable, use `--cache <an allowed writable cache directory>` without changing global permissions.

## Install and authorize

The copied connection request contains a public library instance ID. Use it as `--instance`; it is not a secret and does not replace browser authorization. Substitute the actual host and ID below.

```sh
node connector/setup.mjs plan --host codex --instance <library-instance-id>
node connector/setup.mjs connect --host codex --instance <library-instance-id>
```

Inspect the plan's execution location, registration directories and configuration targets before `connect`. The user's setup request already authorizes routine installation steps. Ask again only when replacing a different library or when the host explicitly requires approval.

The installer changes only PromptDirector's connection configuration and backs up existing files before writing. It stops for damaged configuration, concurrent changes or a same-name connection to another installation. Codex TOML retains other values, but serialization can change formatting or comments; the backup retains the original. Do not override errors to force setup through.

- `awaiting_browser`: no online library found. Inspect `diagnostics`, which checks only the connector's runtime, launcher, pairing and endpoint files. `missing`, `unreadable` and `unknown` refer to those files, not proof of browser, extension or toggle state. Existing files do not prove a handshake. Check installation if program files are absent. Otherwise guide the user to enable Settings → Agent connection in Chrome, or disconnect and enable it again, then verify. Do not automatically reload Chrome, close tabs or discard unsaved edits.
- `library_selection_required`: multiple libraries are online. Ask the user to copy the request from the intended library; do not choose arbitrarily.
- `configuration.state: manual_registration_required`: register the returned command, args and env through the generic host's documented method. Do not rebuild the library interface.
- `host_verification_required`: local integration for that host is unverified; this attempt does not install or write configuration. Follow the returned next step and do not claim connection success.
- If the host has disabled an existing connection, retain that setting and explain that it must be enabled in the host UI.

Without an instance ID, `connect` can discover one unique online library. If none is found, it does not write host configuration; run `connect` again after browser authorization. Each host is bound to its specific instance so changing one library does not silently retarget every Agent.

## Verify both the connector and the current session

```sh
node connector/setup.mjs verify --instance <library-instance-id>
```

`connector_verified` means an independent MCP client completed the handshake, checked the instance ID and searched the library. It does not mean the current Agent session has loaded the tools. Refresh through the host's normal mechanism. If a new conversation is necessary, say so and retain the completed setup steps.

Actually call `promptdirector_status` and `promptdirector_search_cases` in the current session. Show a few candidates if the library contains cases. To show an image, call `promptdirector_read_media` and view the returned local original with host tools. An empty library can still connect successfully; report that it is empty without inventing cases. Setup validation must not write or delete user cases.

Only after these current-session calls succeed may you report that the library is connected and usable. Distinguish setup failure, pending browser authorization and connector verification without session loading. Never print connection secrets, complete host configuration or user credentials.

Business-use instructions are in `SKILL.md` alongside this guide. Ordinary queries do not require whole-library analysis or additional model services.

## Official configuration references

- [Codex](https://developers.openai.com/codex/mcp)
- [Claude Code](https://code.claude.com/docs/en/mcp)
- [WorkBuddy](https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)
- [OpenCode MCP](https://opencode.ai/docs/mcp-servers/) and [configuration](https://opencode.ai/docs/config/)
- [ZCode](https://www.zcode.network/en/docs/mcp-services/)
- [Qoder](https://docs.qoder.com/qoder/connectors)
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) and [MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.zh.md)
- [Qwen Work desktop](https://docs.qwenwork.ai/zh/desktop/connectors) and [connectors](https://docs.qwenwork.cn/features/connectors): check the actual version for local support
- [Doubao Work](https://www.doubao.com/work): local command integration requires verification
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
