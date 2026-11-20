# Antigravity Context Monitor

[简体中文](./README.zh-CN.md)

A minimal, theme-adaptive sidecar UI plugin for **Google Antigravity** that displays real-time context window usage for the active conversation.

## Features

- **Always-on side pane**: Docks in Antigravity's Auxiliary Pane and automatically tracks whichever conversation you switch to.
- **Exact token usage**: Reads local `transcript.jsonl` (read-only, zero external npm dependencies) to display used percentage, used/limit tokens, prompt cache hit rate, and compaction count.
- **Automatic model limit sync**: Syncs context limits from [models.dev](https://models.dev) once every 24 hours into a compact local cache (works offline after first sync), with family-level fallbacks for unreleased/internal models.
- **Per-model custom override**: Click the `used / limit` ratio to adjust or reset the context limit for any model.
- **Theme adaptive**: Automatically matches light, dark, and custom Antigravity themes.

## Installation

### Option 1: Install via Antigravity CLI

```bash
agy plugin install https://github.com/WBBB0730/antigravity-plugin-context-monitor
```

### Option 2: Manual installation

Clone this repository into your global Antigravity plugins directory:

```bash
git clone https://github.com/WBBB0730/antigravity-plugin-context-monitor.git ~/.gemini/config/plugins/context-monitor
```

## Usage

1. Open the **`+`** menu in the conversation header and select **Context**.
2. The panel stays docked in the right auxiliary pane and updates automatically as you chat or switch conversations.
3. Click the capacity ratio (for example `184.1k / 1M`) to pick a preset or set a custom context window limit; click **默认 (Reset)** to restore automatic detection.

## Privacy & Data Access

- Read-only access to `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
- No conversation content is ever uploaded; the only outbound request is a daily `GET https://models.dev/api.json` to refresh public model context limits.

## License

[MIT](./LICENSE)
