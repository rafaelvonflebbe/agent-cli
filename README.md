# Agent CLI

An autonomous loop that uses AI tools to implement user stories defined in a PRD (`prd.json`). It runs iterations until all stories are complete or the iteration limit is reached. Supports both legacy subprocess mode (claude/openclaude) and ACP (Agent Client Protocol) for structured multi-agent communication.

## How it works

1. You create a `prd.json` file in your project directory with the user stories to implement
2. Agent CLI reads the PRD, finds the highest priority story with `passes: false`
3. It invokes the AI tool (claude or openclaude), feeding it instructions from `agent-cli.md`
4. The AI tool implements the story and, upon completion, sets `passes: true` in the PRD
5. The loop repeats for the next story
6. When all stories are complete, the AI tool emits `<promise>COMPLETE</promise>` and the loop ends

## Installation

```bash
npm install
npm run build
npm link  # Optional: to use `agent-cli` globally
```

### Optional dependencies

- **tmux** — for live split-pane log viewing in the monitor. Install with `brew install tmux`
- **Docker** — for sandboxed execution via `--sandbox`
- **ACP adapters** — for multi-agent support. Install as needed: `npm install -g @agentclientprotocol/claude-agent-acp`, `npm install -g @zed-industries/codex-acp`, etc.

## Basic usage

```bash
# In your project directory (where prd.json is located)
agent-cli

# Specify tool and maximum iterations
agent-cli --tool claude 15

# Use an ACP provider (Codex, Copilot, Gemini)
agent-cli --tool codex 10
agent-cli --tool gemini 10

# Point to another directory
agent-cli --directory /path/to/project --tool claude 10

# Initialize a new project with template files
agent-cli --init --directory /path/to/project
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `[max_iterations]` | Maximum number of iterations | `10` |
| `--tool <tool>` | AI tool to use (`claude`, `openclaude`, `codex`, `copilot`, `gemini`, or custom ACP provider) | `claude` |
| `--directory <path>` | Directory containing `prd.json` | Current directory |
| `--project-directory <path>` | Directory where the AI tool works (cwd for spawned process) | Same as `--directory` |
| `--dry-run` | Simulate iterations without spawning tools | `false` |
| `--init` | Bootstrap template files and exit | `false` |
| `--stories <n>` | Max stories to complete per run | All |
| `--resume` | Resume from a previous interrupted session | `false` |
| `--sandbox` | Run AI tool inside a Docker container | `false` |
| `--permission-mode <mode>` | `scoped` (allowlisted tools) or `yolo` (full access) | `scoped` |

## CLI Commands

```bash
agent-cli [options]                    # Run the agent loop
agent-cli status [-d <path>]           # Show completed/pending stories
agent-cli watch --add <path>           # Add a project to the watch list
agent-cli watch --remove <path>        # Remove a project from the watch list
agent-cli watch                        # List watched directories
agent-cli monitor                      # Live-updating dashboard (TUI)
```

## Monitor TUI

The monitor is a full-screen terminal UI that shows the status of all watched projects in real time.

```bash
# Add projects to watch
agent-cli watch --add /path/to/project-a
agent-cli watch --add /path/to/project-b

# Start the monitor
agent-cli monitor
```

### Keyboard controls

| Key | Action |
|-----|--------|
| Up/Down | Navigate projects |
| Enter | Open live log view (tmux split pane or inline) |
| Esc | Close all tmux log panes |
| `s` | Open detail view (stories) |
| `t` | Return to table view |
| `q` | Quit monitor |

### Tmux split panes

For the best experience, run the monitor inside tmux to get split-pane log viewing:

```bash
# Install tmux (macOS)
brew install tmux

# Start a tmux session
tmux new -s agent-cli

# Inside tmux, launch the monitor
agent-cli monitor

# Press Enter on a project — opens a split pane with tail -f .agent-output.log
# Press Esc — closes all log panes
```

When tmux is not available or the monitor is not inside a tmux session, pressing `Enter` shows an inline log view with the last 50 lines refreshed every 2 seconds.

## Notifications (Telegram)

Agent CLI can send Telegram notifications when a story is completed. Configure via `.env` in the agent-cli install directory:

```env
TELEGRAM_TOKEN=123456:ABC-DEF
TELEGRAM_CHAT_ID=987654321
```

Notifications include the story title, ID, and a summary of file changes. If the env vars are not set, notifications are silently skipped.

## Using in another project

You need **two files** in the project directory:

### 1. `prd.json` — Required

```json
{
  "project": "MyProject",
  "branchName": "feature/my-feature",
  "description": "Feature description",
  "userStories": [
    {
      "id": "US-001",
      "title": "Create login endpoint",
      "description": "Implement POST /api/login with validation",
      "acceptanceCriteria": [
        "Endpoint returns 200 with valid token",
        "Returns 401 for invalid credentials"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

**Fields:**
- `priority`: lower number = higher priority (runs first)
- `passes`: `false` = pending, `true` = completed
- `dependsOn`: optional array of story IDs that must be completed first
- `branchName`: when changed, Agent CLI automatically archives the previous run

### 2. `agent-cli.md` — Required

Instructions that the AI tool receives. Or use `--init` to generate a template:

```bash
agent-cli --init --directory /path/to/project
```

This creates `agent-cli.md`, `progress.log`, and a template `prd.json` (skipped if it already exists, auto-detects the current git branch).

## Auto-archiving

When `branchName` in the PRD changes between runs, Agent CLI archives the previous state:

```
archive/YYYY-MM-DD-feature-name/
  ├── prd.json
  └── progress.log
```

## Session persistence

If the loop is interrupted, a `.session.json` file is saved with progress. Resume with:

```bash
agent-cli --resume
```

For ACP providers, the session ID is saved and the agent's full context is restored on resume (via LoadSession). If the session has expired, a new session is created with a summary of previous progress.

## ACP (Agent Client Protocol)

Agent CLI supports the Agent Client Protocol (ACP) for structured communication with AI agents via JSON-RPC 2.0 over stdio. When using an ACP provider, the tool communicates with structured events instead of scanning stdout.

**Built-in ACP providers:**

| Provider | `--tool` | ACP Adapter |
|----------|----------|-------------|
| Claude | `claude` | `@agentclientprotocol/claude-agent-acp` |
| Codex | `codex` | `@zed-industries/codex-acp` |
| Copilot | `copilot` | `@github/copilot --acp` |
| Gemini | `gemini` | `@google/gemini-cli --acp` |

**Custom providers** can be registered in `~/.agent-cli/providers.json`:

```json
{
  "providers": [
    {
      "name": "my-agent",
      "command": "npx",
      "args": ["my-agent-acp"],
      "capabilities": { "fs": true, "terminal": true }
    }
  ]
}
```

### MCP Servers

ACP sessions support attaching MCP (Model Context Protocol) servers for extensible tool access. MCP servers are configured at three levels (later overrides earlier):

1. **Provider defaults** — built into each provider in the registry
2. **PRD-level** — `mcpServers` field in `prd.json`
3. **Project-level** — `.agent-cli/mcp-servers.json` in the working directory

Example `mcpServers` in `prd.json`:
```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"]
    }
  ]
}
```

Example `.agent-cli/mcp-servers.json`:
```json
{
  "servers": [
    {
      "name": "database",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "DATABASE_URL": "postgresql://..." }
    }
  ]
}
```

## File artifacts

| File | Purpose |
|------|---------|
| `prd.json` | User stories, progress, and optional MCP server config |
| `agent-cli.md` | Prompt template for the AI tool |
| `progress.log` | Timestamped iteration log |
| `.agent-output.log` | Human-readable AI tool output (gitignored) |
| `.session.json` | Session state for resume, includes ACP session ID (gitignored) |
| `.agent-cli/mcp-servers.json` | Project-level MCP server overrides |
| `~/.agent-cli/.watch.json` | Global list of watched directories |
| `~/.agent-cli/providers.json` | Custom ACP provider definitions |

## Development

This project uses **Bun** as its primary runtime.

```bash
npm run dev        # Run directly with Bun
npm run build      # Bundle with bun build to dist/
npm run build:old  # Build with tsgo (fallback)
npm run build:tsc  # Build with standard tsc (fallback)
npm run watch      # Compile in watch mode with tsc
```

Requires Node >= 20.
