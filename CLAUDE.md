# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

- **Run:** `npm start` or `npm run dev` — runs directly with **Bun** (`bun run src/index.ts`), no separate build step needed
- **Build:** `npm run build` — bundles with `bun build` to `dist/` for distribution
- **Build (fallback):** `npm run build:old` — **tsgo** (`@typescript/native-preview`), or `npm run build:tsc` for standard `tsc`
- **Watch:** `npm run watch` (standard `tsc --watch`)
- **Global install:** `npm link`

No test framework is configured.

## Architecture

Agent CLI is an autonomous loop that drives an AI tool to iteratively implement user stories defined in a PRD. It supports two execution modes: **legacy** (spawn + stdout scanning for `claude`/`openclaude`) and **ACP** (Agent Client Protocol for structured communication with any ACP-compatible agent).

**Entry point:** `src/index.ts` — CLI powered by `commander`. Parses `[max_iterations]`, `--tool`, `--directory`, `--dry-run` flags, validates that `prd.json` exists, then calls `runAgent()`. In dry-run mode, the loop iterates without spawning external tools, simulating story completion to test the loop orchestration.

**Core loop flow (`src/core/iterator.ts`):**
1. Load `prd.json` via `PRDManager`
2. Initialize archive system (creates `progress.log` if missing)
3. Check if branch changed — if so, archive previous run
4. Determine execution path: ACP (if `--tool` maps to an ACP provider) or legacy (spawn + stdout)
5. Iterate up to `maxIterations`:
   - **ACP path:** create/reuse session, send prompt as ContentBlock, collect structured SessionUpdates, detect completion from protocol
   - **Legacy path:** spawn the AI tool, stream its prompt file to stdin, capture stdout to detect `<promise>COMPLETE</promise>` signal
6. After each iteration, reload PRD to check if all stories have `passes: true`

**Key modules:**
- `src/core/tool-runner.ts` — Spawns `claude` or `openclaude` as child processes (legacy path). Pipes the prompt file to stdin. Detects completion by scanning stdout for the signal string. In `--dry-run` mode, this module is bypassed entirely.
- `src/core/acp-client.ts` — ACP client wrapping `@agentclientprotocol/sdk`. Handles full session lifecycle: launch agent subprocess, initialize protocol handshake, create session, send prompts as ContentBlocks, subscribe to SessionUpdate notifications, parse structured content (text blocks, tool calls, diffs, terminal output), detect session completion and idle states. Includes filesystem boundary validation (allowedRoots) and typed event bus for UI integration.
- `src/core/acp-registry.ts` — Multi-agent provider registry. Built-in providers: Claude, Codex, Copilot, Gemini. Custom providers via `~/.agent-cli/providers.json`. Each provider has: name, command, args, capabilities, default MCP servers. CLI `--tool` flag maps to provider name.
- `src/core/mcp-config.ts` — MCP server configuration loading and resolution. Three config levels (later overrides earlier): provider defaults, PRD `mcpServers` field, project-level `.agent-cli/mcp-servers.json`. Converts simplified `McpServerConfig` to ACP SDK's `McpServer` format.
- `src/core/prd.ts` — `PRDManager` class: load/save/validate `prd.json`, track story completion, find next incomplete story by priority (lower number = higher priority).
- `src/core/archiver.ts` — When `branchName` in PRD changes, archives previous `prd.json` + `progress.log` to `archive/YYYY-MM-DD-feature-name/`. Tracks last branch in `.last-branch`.
- `src/core/config.ts` — Defaults (tool: `claude`, maxIterations: `10`, delay: `2000ms`), validation, tool command/args mapping. ACP provider awareness via `isACPProvider()` and `getACPProvider()`.
- `src/core/types.ts` — All TypeScript interfaces: `PRD`, `UserStory`, `AgentConfig`, `ToolResult`, `ArchiveInfo`, `McpServerConfig`, `ACPProvider`, `ACPProviderCapabilities`, `ProvidersConfig`, etc.

**Observability modules:**
- `src/core/monitor.ts` — Ink-based full-screen TUI lifecycle (alt screen buffer, cursor management, cleanup).
- `src/core/monitor-ui.tsx` — React/Ink components: project table, detail view (stories/logs), inline log fallback, keyboard navigation. Shows resumed session indicator (↻).
- `src/core/monitor-data.ts` — Polling logic: collects ProjectStatus from watched directories, reads agent log tails. Detects ACP resumed sessions via `acpSessionId`.
- `src/core/tmux.ts` — Detects tmux session/binary availability, manages split panes (`tmux split-pane -h` with `tail -f`), tracks open panes per directory. Requires tmux installed and the monitor running inside a tmux session. Falls back to inline log view when tmux is unavailable.
- `src/core/telegram.ts` — Sends HTML-formatted notifications via Telegram Bot API on story completion. Configured via `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` (loaded from agent-cli install directory, not cwd).

**Other modules:**
- `src/core/session.ts` — `.session.json` persistence for interrupted run recovery (`--resume` flag). Stores ACP session ID for protocol-level session resumption.
- `src/core/watch-config.ts` — Global `~/.agent-cli/.watch.json` for registered project directories.
- `src/core/init.ts` — `--init` scaffolding: copies `agent-cli.md`, creates `progress.log`, generates template `prd.json` with auto-detected git branch.

**Utilities:** `src/utils/file-utils.ts` (JSON/text file I/O), `src/utils/git-utils.ts` (git status capture/diff, branch detection), `src/utils/logger.ts` (chalk-based colored logging with levels), `src/utils/format-utils.ts` (human-readable duration formatting).

## PRD Format

The working directory must contain `prd.json` with: `project`, `branchName`, `description`, and `userStories[]` (each with `id`, `title`, `description`, `acceptanceCriteria[]`, `priority`, `passes`, `notes`). Optional: `projectDirectory` (cwd for spawned process), `mcpServers[]` (MCP servers for ACP sessions).

## ACP (Agent Client Protocol)

When `--tool` maps to an ACP provider (claude, codex, copilot, gemini, or custom), the iterator uses the ACP client instead of the legacy tool-runner. ACP provides structured communication over JSON-RPC 2.0 on stdio.

**Built-in providers:** Claude (`@agentclientprotocol/claude-agent-acp`), Codex (`@zed-industries/codex-acp`), Copilot (`@github/copilot --acp`), Gemini (`@google/gemini-cli --acp`).

**Custom providers:** Add entries to `~/.agent-cli/providers.json`:
```json
{ "providers": [{ "name": "my-agent", "command": "npx", "args": ["my-agent-acp"], "capabilities": { "fs": true, "terminal": true } }] }
```

**MCP servers** can be configured at three levels (later overrides earlier):
1. Provider defaults (built into the registry)
2. PRD-level `mcpServers` field in `prd.json`
3. Project-level `.agent-cli/mcp-servers.json`

## CLI Commands

```
agent-cli [max_iterations] [options]   # Run the agent loop
agent-cli status [-d <path>]           # Show story progress
agent-cli watch [--add|--remove <path>]# Manage watched directories
agent-cli monitor                      # Live-updating TUI dashboard
```

**Main command options:** `--tool`, `--directory`, `--project-directory`, `--dry-run`, `--init`, `--stories`, `--resume`, `--sandbox`, `--permission-mode`

## Tmux Integration

The monitor TUI supports tmux split panes for live log viewing. Requirements:
- tmux must be installed (`brew install tmux`)
- The monitor must be started inside a tmux session (`tmux new -s agent-cli`)
- Press `l` on a project to open a split pane with `tail -f .agent-output.log`
- Press `L` to close all log panes
- Falls back to inline log view when tmux is not available

## Conventions

- ESM-only (`"type": "module"`), ES2022 target, strict mode
- Factory functions (`createXxx`) alongside classes for each module
- Node >= 20
- Do NOT add `Co-Authored-By` lines to commits — no co-author trailing lines
