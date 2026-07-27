# Non-Agentic Commands MCP

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that wraps **[Pi](https://github.com/earendil-works/pi)** — the AI coding assistant — as a set of callable tools. This enables any MCP host (Claude Desktop, VS Code with Cline/Continue, etc.) to spawn, manage, and prompt Pi sessions programmatically without running an interactive terminal.

**Key idea:** Instead of running `pi --mode rpc` manually and piping JSON over stdin/stdout, this server handles the full lifecycle — spawning Pi, forwarding commands, collecting responses — and exposes it all through clean MCP tool calls.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Available Tools](#available-tools)
  - [Session Lifecycle](#session-lifecycle)
  - [Prompting](#prompting)
  - [Session Management](#session-management)
- [Usage Examples](#usage-examples)
  - [1. Quick Start: Default Session](#1-quick-start-default-session)
  - [2. Custom Provider & Model](#2-custom-provider--model)
  - [3. Reconnect to a Previous Session](#3-reconnect-to-a-previous-session)
  - [4. Raw RPC Commands](#4-raw-rpc-commands)
- [Session Number Reference](#session-number-reference)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## How It Works

```
┌──────────────────┐    MCP Protocol     ┌──────────────────────────────┐
│   MCP Host       │ ◄──────────────►    │  non-agentic-commands-mcp    │
│  (Claude, Cline, │                     │       (index.js)             │
│   Continue, etc.)│                     │                              │
└──────────────────┘                     │  Manages Pi child process    │
        │                                │  via stdio (JSON-RPC)         │
        │  Tool calls                    │                              │
        ▼                                │  ┌─────────────────────┐     │
  ┌────────────┐                         │  │   Pi (ai coding     │     │
  │ start_session│─────────────────────────►│   agent subprocess) │     │
  │ pi_agent_prompt│──────────────────────►│                     │     │
  │ pi_agent_rpc  │──────────────────────►│  └─────────────────────┘     │
  └────────────┘                         └──────────────────────────────┘
```

1. The MCP host starts this server as a subprocess (stdio transport).
2. You call `start_session` (or `start_session_custom`) to spawn Pi in RPC mode.
3. You call `pi_agent_prompt` to send natural-language prompts to the running Pi.
4. Pi responds with tool calls (bash, read, edit, write), thinking blocks, and text — all returned as formatted text to the MCP host.
5. Session state (conversation history) persists in Pi's session files, so you can reconnect later.

---

## Prerequisites

- **[Node.js](https://nodejs.org/)** v18 or later
- **[Pi](https://github.com/earendil-works/pi)** installed globally (`npm install -g @earendil-works/pi-coding-agent`)
- An MCP host client (e.g., [Claude Desktop](https://claude.ai/download), VS Code with [Cline](https://github.com/cline/cline) or [Continue](https://continue.dev), or any MCP-compatible tool)
- An API key for whichever LLM provider Pi will use (set via environment variable — see Pi docs for supported providers)

---

## Installation

```bash
# Clone the repo
git clone <your-repo-url> non-agentic-commands-mcp
cd non-agentic-commands-mcp

# Install dependencies
npm install
```

That's it. The server has only two dependencies: `@modelcontextprotocol/sdk` and `cross-spawn`.

---

## Configuration

Add the server to your MCP host's config file. The location depends on your client:

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "non-agentic-commands": {
      "command": "node",
      "args": ["path/to/non-agentic-commands-mcp/index.js"],
      "env": {
        "PI_SESSION_DIR": "/path/to/pi/sessions"
      }
    }
  }
}
```

### VS Code Cline / Continue

Add to your MCP settings file (e.g., `.vscode/mcp.json` or Continue's `config.json`):

```json
{
  "mcpServers": {
    "non-agentic-commands": {
      "command": "node",
      "args": ["C:/Users/you/projects/non-agentic-commands-mcp/index.js"],
      "env": {
        "PI_SESSION_DIR": "C:/Users/you/.pi/sessions"
      }
    }
  }
}
```

> **Note:** The `PI_SESSION_DIR` environment variable is optional but **required for session-number-based reconnect** (e.g., reconnecting to your most recent session). Set it to the directory where Pi stores session `.jsonl` files — typically `~/.pi/sessions`.

---

## Available Tools

### Session Lifecycle

#### `start_session`

Start a Pi session with default settings (nano-gpt / tencent/hy3).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_number` | number | No | `0` = new session (default), `1` = most recent, `2` = second most recent, etc. |

**Example call:**
```json
{
  "name": "start_session",
  "arguments": {}
}
```

Returns: `"Pi started — fresh session"` or `"Pi started — reconnected to session 1 (/path/to/session.jsonl)"`

#### `start_session_custom`

Start a Pi session with your own CLI arguments (provider, model, extensions, skills, etc.).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `args` | string | Yes | Custom arguments (e.g., `--provider openai --model gpt-4o --name "refactor session"`) |
| `session_number` | number | No | `0` = new session (default), `1` = most recent, `2` = second most recent, etc. |

**Example call:**
```json
{
  "name": "start_session_custom",
  "arguments": {
    "args": "--provider anthropic --model claude-sonnet-4-20250514 --name 'api-design'"
  }
}
```

Any Pi CLI flag works here — see `pi --help` for the full list. Common ones:

| Flag | Purpose |
|------|---------|
| `--provider <name>` | LLM provider (google, openai, anthropic, deepseek, etc.) |
| `--model <pattern>` | Model ID or pattern (supports `provider/id` syntax) |
| `--name <name>` / `-n <name>` | Human-readable session name |
| `--skill <path>` | Load a skill file |
| `--extension <path>` / `-e <path>` | Load an extension |
| `--no-tools` | Disable all tools |
| `--tools <list>` | Allowlist of tool names |
| `--exclude-tools <list>` | Denylist of tool names |
| `--thinking <level>` | Thinking level (off, minimal, low, medium, high, xhigh, max) |
| `--continue` / `-c` | Continue previous session |
| `--resume` / `-r` | Select a session to resume |

### Prompting

#### `pi_agent_prompt`

Send a natural-language prompt to the running Pi session. Pi will respond with tool calls (bash, read, edit, write), text, and thinking blocks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | The prompt to send. |

**Example call:**
```json
{
  "name": "pi_agent_prompt",
  "arguments": {
    "text": "List all .ts files in the src directory and count the total lines of code."
  }
}
```

**Returns:** The assistant's full response as formatted text, including:
- Text content blocks
- Tool call descriptions (`[tool: bash] {"command": "ls -la"}`)
- Thinking blocks (`[thinking] step-by-step reasoning`)
- Tool results in context

#### `pi_agent_rpc`

Send a raw RPC command to the running Pi session. This gives you full access to Pi's RPC protocol (prompt, get_state, switch_session, new_session, cancel, etc.).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Raw JSON RPC payload to forward verbatim. |

**Example call:**
```json
{
  "name": "pi_agent_rpc",
  "arguments": {
    "command": "{\"type\": \"prompt\", \"message\": \"Read package.json and tell me the dependencies\"}"
  }
}
```

**Returns:** The raw JSON event stream as a formatted JSON string.

### Session Management

#### `pi_session_info`

Get the current session state from the running Pi daemon (session ID, file path, model, provider, usage stats, etc.).

```json
{
  "name": "pi_session_info",
  "arguments": {}
}
```

**Returns:** JSON object with session metadata.

#### `pi_session_switch`

Reconnect to a different session file at runtime without restarting Pi.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionPath` | string | No | Path to a session `.jsonl` file to switch to. |
| `session_number` | number | No | Alternative: session number (1 = most recent, 2 = second most recent). Ignored if `sessionPath` is set. |

```json
{
  "name": "pi_session_switch",
  "arguments": {
    "session_number": 1
  }
}
```

#### `pi_session_new`

Start a fresh session in the running Pi daemon without restarting the process.

```json
{
  "name": "pi_session_new",
  "arguments": {}
}
```

---

## Usage Examples

### 1. Quick Start: Default Session

This starts Pi with the default provider/model and sends a prompt.

```
Step 1: start_session({})                     → "Pi started — fresh session"
Step 2: pi_agent_prompt({text: "Say hello"})  → "👋 Hello! I'm Pi, your AI coding assistant..."
```

The prompt response includes everything Pi does — thinking, tool calls, and final text output — all in one formatted string.

### 2. Custom Provider & Model

Use `start_session_custom` to pick a specific provider and model.

```
Step 1: start_session_custom({
  args: "--provider anthropic --model claude-sonnet-4-20250514 --name 'refactor-auth'"
})                                                    → "Pi started — fresh session"

Step 2: pi_agent_prompt({
  text: "Read the auth module and suggest improvements"
})                                                    → Full analysis with tool calls
```

### 3. Reconnect to a Previous Session

If `PI_SESSION_DIR` is set, you can reconnect to any recent session by number.

```
Step 1: start_session({session_number: 1})    → "Pi started — reconnected to session 1 (...)"
Step 2: pi_agent_prompt({text: "Continue where we left off"})  → Resumes from history
```

Session numbers:
- `0` (default) = brand-new session
- `1` = most recent session
- `2` = second most recent
- `3` = third most recent
- etc.

You can also switch sessions at runtime:

```
Step 1: start_session({})                       → Fresh session
Step 2: pi_session_switch({session_number: 2}) → Switched to second-most-recent session
Step 3: pi_agent_prompt({text: "Review what we did yesterday"})
```

### 4. Raw RPC Commands

For advanced use cases, send arbitrary RPC commands directly.

```
Step 1: start_session({})
Step 2: pi_agent_rpc({
  command: "{\"type\": \"get_state\"}"
})                                                    → Full session state JSON
```

This is useful for:
- Getting detailed session metadata
- Canceling in-flight responses
- Forking sessions
- Accessing Pi RPC features not exposed as dedicated tools

---

## Session Number Reference

The session-number system lets you reconnect to past sessions without specifying full file paths.

| Number | Meaning |
|--------|---------|
| `0` | New session (default) |
| `1` | Most recent session |
| `2` | Second most recent |
| `3` | Third most recent |
| `N` | Nth most recent |

**How it works:** When `PI_SESSION_DIR` is set, the server lists all `.jsonl` files in that directory sorted by modification time (newest first), then picks the Nth. This is the same directory Pi uses for session storage (typically `~/.pi/sessions` or your custom `--session-dir`).

**Does not require** `PI_SESSION_DIR`? Yes it does — if the variable is unset, all numbered lookups return `null` and those session numbers are ignored (defaults to a new session).

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PI_SESSION_DIR` | No | Path to Pi's session storage directory. Required for session-number-based reconnect. Typically `~/.pi/sessions`. |

The server also respects all standard Pi environment variables (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, etc.) — these are inherited from the parent process or can be set in the MCP host's `env` config.

---

## Troubleshooting

### "No Pi session running. Call start_session first."

You must call `start_session` or `start_session_custom` before any other tool. The server does not auto-spawn Pi — you control when the session starts.

### Session-number reconnect is ignored

Check that `PI_SESSION_DIR` is set correctly and points to a directory containing `.jsonl` session files. If the variable is missing or the directory is empty, the server falls back to creating a new session.

### "Invalid JSON in 'command'"

The `pi_agent_rpc` tool expects valid JSON in the `command` string. Double-check your JSON syntax (proper quotes, no trailing commas).

### Pi process crashes or hangs

Kill and restart the MCP server. Each `start_session` call kills any existing Pi process before spawning a new one, so you can always reset by calling it again.

### No output from pi_agent_prompt

Some prompts may produce no assistant response (e.g., empty or malformed input). The tool returns `"(no response)"` in that case. Check that Pi was properly configured with a valid provider and API key.

---

## Development

```bash
# Run the server directly (stdio mode, for testing)
node index.js

# Test with a simple prompt via stdin
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node index.js

# Manually inspect the RPC protocol for debugging
pi --mode rpc --provider nano-gpt --model tencent/hy3
# Then type: {"type":"prompt","message":"hello"}
```

### Project Structure

```
non-agentic-commands-mcp/
├── index.js          # Main MCP server — tool definitions & handlers
├── package.json      # Node.js manifest
├── examples/         # Pi usage reference
│   ├── pi-commands.txt       # Full Pi CLI reference
│   ├── pi-rpc-commands.txt   # Full RPC protocol spec
│   ├── response.jsonl        # Example RPC response stream
│   ├── res2.jsonl            # Another sample response
│   └── pi-session-*.html     # Exported session HTML
└── README.md         # This file
```

---

## License

ISC
