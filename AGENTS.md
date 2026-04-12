# AGENTS.md

Instructions for AI agents working on the agent-cli codebase.

## Prerequisites

- **Bun** runtime (primary) or Node >= 20
- **tmux** — required for monitor split-pane log viewing (`brew install tmux`). The monitor works without tmux (falls back to inline logs), but split panes require it.
- **Docker** — optional, needed only for `--sandbox` mode

## How the Agent Loop Works

1. `prd.json` defines user stories with priorities
2. The iterator picks the highest-priority incomplete story
3. It spawns the AI tool (claude/openclaude) as a child process
4. The tool implements the story, then sets `passes: true` in `prd.json`
5. When all stories pass, the tool emits `<promise>COMPLETE</promise>` and the loop ends

## Project Structure

```
src/
├── index.ts              # CLI entry (commander)
├── core/
│   ├── iterator.ts       # Main orchestration loop
│   ├── tool-runner.ts    # Spawns AI tools, streams output
│   ├── prd.ts            # PRD load/save/validate (Ajv)
│   ├── config.ts         # Tool registry, defaults
│   ├── types.ts          # TypeScript interfaces
│   ├── init.ts           # --init scaffolding
│   ├── session.ts        # .session.json persistence
│   ├── archiver.ts       # Branch-change archiving
│   ├── monitor.ts        # Ink TUI lifecycle
│   ├── monitor-ui.tsx    # React/Ink components
│   ├── monitor-data.ts   # Polling/data collection
│   ├── tmux.ts           # tmux split-pane management
│   ├── telegram.ts       # Telegram notifications
│   └── watch-config.ts   # ~/.agent-cli/.watch.json
└── utils/
    ├── file-utils.ts     # JSON/text I/O
    ├── git-utils.ts      # git status, branch detection
    ├── logger.ts         # chalk logging
    └── format-utils.ts   # duration formatting
```

## Key Files to Understand

- **`src/core/iterator.ts`** — The core loop. Read this first to understand the flow.
- **`src/core/tool-runner.ts`** — How AI tools are spawned and their output is parsed (stream-json for claude).
- **`src/core/tmux.ts`** — Tmux integration. Uses `execSync` to run `tmux split-pane`, `tmux kill-pane`, `tmux list-panes`. Detects availability via `process.env.TMUX` and `which tmux`.
- **`agent-cli.md`** — The prompt template piped to the AI tool's stdin. This is what the spawned agent receives.

## Tmux Integration Details

The tmux module (`src/core/tmux.ts`) provides split-pane log viewing in the monitor TUI:

- **Detection:** `isInsideTmux()` checks `TMUX` and `TERM` env vars. `isTmuxAvailable()` checks if the `tmux` binary exists.
- **Opening panes:** `openLogPane(directory, projectName)` runs `tmux split-pane -h` with a `tail -f .agent-output.log` command. Each directory gets one pane tracked in a `Map<directory, paneId>`.
- **Closing panes:** `closeLogPane(directory)` kills a specific pane. `closeAllLogPanes()` kills all tracked panes (triggered by `Esc` key or monitor exit).
- **Fallback:** When tmux is unavailable, the monitor shows an inline log view (last 50 lines, refreshed every 2s via Ink).

## Building and Running

```bash
bun run src/index.ts              # Run directly
bun run src/index.ts monitor      # Start the monitor TUI
bun run src/index.ts status       # Show story progress
bun run src/index.ts --dry-run 5  # Simulate 5 iterations
bun run build                     # Bundle to dist/
```

## Testing Tmux

```bash
# Install tmux if not present
brew install tmux

# Start a tmux session
tmux new -s agent-cli

# Inside tmux, run the monitor
cd /path/to/project
bun run src/index.ts monitor

# Press Enter on a project to open a split pane with live logs
# Press Esc to close all log panes
# Press 's' to view stories
# Press 'q' to quit
```

## Conventions

- ESM-only (`"type": "module"`), ES2022 target, strict mode
- Do NOT add `Co-Authored-By` lines to commits
- Factory functions (`createXxx`) alongside classes
- No test framework configured
