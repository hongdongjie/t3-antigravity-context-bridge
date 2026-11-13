# t3-antigravity-context-bridge

English | [简体中文](./README.zh-CN.md)

A zero-dependency Node.js stdio wrapper that surfaces **Antigravity CLI (`agy`) context window usage** inside **[T3 Code](https://github.com/pingdotgg/t3code)**'s built-in **Context** panel via standard ACP `usage_update` notifications.

## Why this exists

T3 Code natively renders context window usage (`used / size` tokens and progress bar) whenever an ACP provider emits `session/update` with `sessionUpdate: "usage_update"`.

Official Antigravity CLI (`agy acp`) records per-turn context window metadata in its local session SQLite database (`~/.gemini/antigravity-cli/conversations/<sessionId>.db`), while its ACP stream does not yet emit `usage_update` events.

`bridge.mjs` sits transparently between T3 Code and your local `agy` executable:

- Forwards all JSON-RPC / ACP traffic in both directions untouched (authentication, client identity, model options, tool calls, approvals).
- Opens `<sessionId>.db` in **read-only** mode once a second and decodes the latest `gen_metadata` context snapshot (`estimated_tokens_used` and `max_context_tokens`).
- Emits a standard ACP `usage_update` notification only when token counts change.
- Automatically steps aside for that session if a future `agy` release emits native `usage_update` notifications.
- Requires **zero npm packages** and **zero modifications** to either T3 Code or the `agy` binary.

## Requirements

- **Node.js `>= 22.5.0`** (uses Node's built-in `node:sqlite` module)
- **[T3 Code](https://github.com/pingdotgg/t3code)** with **Antigravity CLI** added under *Settings → Providers* (`antigravity-cli`)
- Official **Antigravity CLI** (`agy` / `antigravity`) installed on your machine

## Quick Start

### Option A: Automatic setup script

1. Clone or download this repository:

   ```bash
   git clone https://github.com/hongdongjie/t3-antigravity-context-bridge.git
   cd t3-antigravity-context-bridge
   ```

2. Run the setup helper (backs up `~/.t3/userdata/settings.json` to `settings.before-context-bridge.json` on first run and wraps your existing `antigravity-cli` command):

   ```bash
   node --no-warnings setup.mjs
   ```

3. Reload T3 Code or start a new chat session, open **Toggle thread details panel** (top-right), and send a message to view live **Context** token usage.

To restore your original direct `agy` configuration at any time:

```bash
node --no-warnings setup.mjs --uninstall
```

### Option B: Manual configuration in T3 Code

In `~/.t3/userdata/settings.json` (or under **Settings → Providers → Antigravity CLI**), wrap your `agy` command with `node` and `bridge.mjs`:

```json
{
  "providerInstances": {
    "antigravity-cli": {
      "driver": "acpRegistry",
      "enabled": true,
      "config": {
        "source": "local",
        "commandPath": "node",
        "commandArgs": [
          "--no-warnings",
          "/absolute/path/to/t3-antigravity-context-bridge/bridge.mjs",
          "/absolute/path/to/agy",
          "acp",
          "--process-per-session"
        ]
      }
    }
  }
}
```

> **Windows tip:** Provide full paths such as `C:\\Program Files\\nodejs\\node.exe` for `commandPath` and `C:\\Users\\<you>\\AppData\\Local\\agy\\bin\\agy.exe` for the `agy` path inside `commandArgs`.

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ANTIGRAVITY_CONVERSATIONS_DIR` | `~/.gemini/antigravity-cli/conversations` | Override if your Antigravity CLI uses a custom data directory. |
| `T3_SETTINGS_PATH` | `~/.t3/userdata/settings.json` | Override target settings path when running `setup.mjs`. |

## Running Tests

```bash
npm test
```

## Compatibility & Notes

- Verified with **Antigravity CLI `1.5.6`** and **T3 Code `0.1.9` / `0.1.10-nightly`**.
- **Graceful fallback:** `context.mjs` decodes `gen_metadata` using `agy 1.5.6`'s internal Protobuf field path (`1 → 9 → 10`). If the database is busy, missing (before the first model turn), or changes schema in a future CLI update, the bridge skips supplemental usage updates without affecting normal ACP communication.
- **Privacy:** Never reads conversation messages, prompts, OAuth credentials, or API keys. Only changed numeric `used/size` counts are logged to `stderr`.
- **Known T3 Code upstream behavior:** In T3 Code `0.1.9`–`0.1.10-nightly`, live context updates display immediately during turns and upon session reload; if the final post-turn `usage_update` arrives ~1 second after T3 has already finalized the turn, disk persistence of that final tick awaits upstream `sessionScoped` handling in T3 Code.

## License

[MIT](./LICENSE) — shared as-is for personal and community use.
