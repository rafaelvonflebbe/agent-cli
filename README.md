# Agent CLI

An autonomous loop that uses AI tools (claude or openclaude) to implement user stories defined in a PRD (`prd.json`). It runs iterations until all stories are complete or the iteration limit is reached.

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

## Basic usage

```bash
# In your project directory (where prd.json is located)
agent-cli

# Specify tool and maximum iterations
agent-cli --tool claude 15

# Point to another directory
agent-cli --directory /path/to/project --tool claude 10

# Initialize a new project with template files
agent-cli --init --directory /path/to/project
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `[max_iterations]` | Maximum number of iterations | `10` |
| `--tool <tool>` | AI tool to use (`claude`, `openclaude`) | `claude` |
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
| Enter | Open detail view (stories/logs) |
| `l` | Open live log view (tmux split pane or inline) |
| `L` | Close all tmux log panes |
| `s` | Switch to stories view (in detail) |
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

# Press 'l' on a project — opens a split pane with tail -f .agent-output.log
# Press 'L' — closes all log panes
```

When tmux is not available or the monitor is not inside a tmux session, pressing `l` shows an inline log view with the last 50 lines refreshed every 2 seconds.

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

## File artifacts

| File | Purpose |
|------|---------|
| `prd.json` | User stories and progress |
| `agent-cli.md` | Prompt template for the AI tool |
| `progress.log` | Timestamped iteration log |
| `.agent-output.log` | Human-readable AI tool output (gitignored) |
| `.session.json` | Session state for resume (gitignored) |
| `~/.agent-cli/.watch.json` | Global list of watched directories |

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
