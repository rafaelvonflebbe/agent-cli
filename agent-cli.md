You are an autonomous development agent. Your job is to implement user stories from a PRD file.

## Instructions

1. Read `prd.json` in the current directory
2. Find the story with the highest priority (lowest number) where `passes` is `false`
3. Implement that story — write code, edit files, run builds as needed
4. Verify your work against the story's `acceptanceCriteria`
5. If all criteria are met, update the story's `passes` field to `true` in `prd.json`
6. If all stories have `passes: true`, respond with exactly: `<promise>COMPLETE</promise>`
7. If some stories remain incomplete, stop and wait for the next iteration

## Rules

- Only work on ONE story per iteration
- Always verify the build passes (`npm run build`) before marking a story as complete
- Update `prd.json` in place — do not rename or move it
- Be thorough: read existing code before making changes
- Follow existing code conventions and patterns in the project
- Do NOT add `Co-Authored-By` lines to commits — no co-author trailing lines

## PRD Format and Validation

`prd.json` is validated against `prd.schema.json` using Ajv on every load. The schema enforces:

- **Required top-level fields:** `project` (string), `branchName` (string), `description` (string), `userStories` (array, at least 1 item)
- **Required userStory fields:** `id` (string), `title` (string), `description` (string), `acceptanceCriteria` (array of strings, min 1), `priority` (number, min 1), `passes` (boolean), `notes` (string)
- No additional properties are allowed at any level
- If validation fails, a clear error message lists the specific fields that failed

## Architecture

Agent CLI is an autonomous loop that drives an AI tool to iteratively implement user stories defined in a PRD. It supports two execution modes: **legacy** (spawn + stdout scanning for `claude`/`openclaude`) and **ACP** (Agent Client Protocol for structured JSON-RPC 2.0 communication with any ACP-compatible agent).

**Entry point:** `src/index.ts` — CLI powered by `commander`. Parses `[max_iterations]`, `--tool`, `--directory`, `--dry-run`, `--init`, `--stories` flags. Validates that `prd.json` exists, then calls `runAgent()`. Also provides a `status` subcommand.

**Core loop flow (`src/core/iterator.ts`):**
1. Load `prd.json` via `PRDManager` (validates against schema)
2. Initialize archive system (creates `progress.log` if missing)
3. Check if branch still exists — if stale, archive run, clear branchName, and stop
4. Check if branch changed — if so, archive previous run
5. Determine execution path: ACP (if `--tool` maps to an ACP provider) or legacy (spawn + stdout)
6. Iterate up to `maxIterations`:
   - **ACP path:** create/reuse ACP session, send prompt as ContentBlock, collect structured SessionUpdates, detect completion from protocol
   - **Legacy path:** spawn the AI tool, stream its prompt file to stdin, capture stdout to detect `<promise>COMPLETE</promise>` signal
7. After each iteration: reload PRD, log progress to `progress.log`, detect file changes, check for story completions
8. Respect `--stories` limit if set — stop after N stories completed in this run

**Key modules:**
- `src/core/tool-runner.ts` — Spawns registered AI tools as child processes (legacy path). Pipes the prompt file to stdin. Detects completion by scanning stdout for the signal string. In `--dry-run` mode, this module is bypassed entirely.
- `src/core/acp-client.ts` — ACP client wrapping `@agentclientprotocol/sdk`. Manages full session lifecycle: launch agent subprocess, protocol handshake, create session, send prompts, receive structured SessionUpdates. Includes filesystem boundary validation and typed event bus.
- `src/core/acp-registry.ts` — Multi-agent provider registry. Built-in providers: Claude, Codex, Copilot, Gemini. Custom providers via `~/.agent-cli/providers.json`. Maps `--tool` flag to ACP adapter commands.
- `src/core/mcp-config.ts` — MCP server configuration loading and resolution. Three config levels: provider defaults, PRD `mcpServers`, project-level `.agent-cli/mcp-servers.json`.
- `src/core/prd.ts` — `PRDManager` class: load/save/validate `prd.json` against JSON schema, track story completion, find next incomplete story by priority (lower number = higher priority). Schema validation uses Ajv with `prd.schema.json`.
- `src/core/archiver.ts` — When `branchName` in PRD changes, archives previous `prd.json` + `progress.log` to `archive/YYYY-MM-DD-feature-name/`. Tracks last branch in `.last-branch`. Creates and resets `progress.log` with headers including branch name and timestamp.
- `src/core/config.ts` — Tool registry, ACP provider awareness, defaults (tool: `claude`, maxIterations: `10`, delay: `2000ms`), validation, and tool command/args mapping.
- `src/core/init.ts` — `--init` command: copies `agent-cli.md`, creates `progress.log` header, and optionally creates a template `prd.json` in the target directory. Skips `prd.json` if it already exists.
- `src/core/types.ts` — All TypeScript interfaces: `PRD`, `UserStory`, `AgentConfig`, `ToolResult`, `ArchiveInfo`, `PRDStatus`, `McpServerConfig`, `ACPProvider`, `ACPProviderCapabilities`, `ProvidersConfig`, etc.
- `src/utils/git-utils.ts` — Git utilities: `captureGitStatus()` captures `git status --porcelain`, `diffGitStatus()` compares two snapshots to detect added/modified/removed files, `branchExists()` checks if a branch exists locally, `displayFileChanges()` renders changes with chalk colors.
- `src/utils/file-utils.ts` — JSON/text file I/O helpers.
- `src/utils/logger.ts` — chalk-based colored logging with levels and iteration headers showing the target story.

**Utilities:** `src/utils/file-utils.ts` (JSON/text file I/O), `src/utils/logger.ts` (chalk-based colored logging with levels).

## CLI Commands and Flags

### Main command
```
agent-cli [max_iterations] [options]
```

**Options:**
- `--tool <tool>` — AI tool to use (default: `claude`). Available tools: `claude`, `openclaude` (legacy), `codex`, `copilot`, `gemini` (ACP). Add custom ACP providers via `~/.agent-cli/providers.json`.
- `--directory <path>` — Working directory containing `prd.json` (default: cwd)
- `--dry-run` — Simulate iterations without spawning tools. Logs which story would be picked, which tool would run, and simulates completing one story per iteration.
- `--init` — Bootstrap agent-cli files (`agent-cli.md`, `progress.log`, template `prd.json`) in the target directory and exit. Does not start the agent loop. Skips `prd.json` if it already exists.
- `--stories <number>` — Maximum number of stories to complete per run. Stops the loop after N stories are completed in this run, even if more remain. Respects `max_iterations` as the hard upper bound.

### Status subcommand
```
agent-cli status [--directory <path>]
```
Reads `prd.json` and displays: total stories, completed count, pending count, and a list of pending stories with their id, title, and priority. If all stories are complete, shows a success message. Useful for quickly checking progress without running the agent loop.

## Stale Branch Detection

At the start of each run, the iterator checks if the `branchName` in `prd.json` still exists as a local git branch (`git branch --list`). If the branch no longer exists (was merged and deleted, or manually removed), the loop:

1. Archives the run under the stale branch name
2. Initializes `progress.log` and logs which branch was stale
3. Clears `branchName` in `prd.json` (sets to empty string)
4. Stops the loop with a warning

This prevents the agent from running on a ghost branch. The user must update `prd.json` with a valid branch name to resume.

## Progress Logging

Every iteration writes a timestamped entry to `progress.log` with the iteration number, targeted story id/title, and completion status. Entries include the active branch name. When all stories complete, a final summary entry is appended. If max iterations are reached without completion, a warning entry is appended.

## File Change Tracking

In live mode (not dry-run), the iterator captures `git status --porcelain` before and after each iteration to detect file changes (added, modified, removed). Changes are displayed with colored prefixes. When a story is detected as completed, a cumulative file changes report is shown in the CLI and appended to `progress.log`.

## PRD Schema Validation

`prd.json` is validated against `prd.schema.json` on every load via Ajv. The schema enforces required fields and types. If validation fails, the error message lists the specific fields that failed (e.g., `"userStories/0/id must NOT be shorter than 1 characters"`). Existing valid `prd.json` files remain backward compatible.

## Conventions

- ESM-only (`"type": "module"`), ES2022 target, strict mode
- Factory functions (`createXxx`) alongside classes for each module
- Node >= 20

## Safety Rules

You MUST follow these rules at all times. Violations are not permitted under any circumstances.

### Filesystem Boundaries
- NEVER modify, delete, or create files outside the project directory
- NEVER access files in parent directories, sibling directories, or absolute paths outside the project
- NEVER modify `.git/` contents directly
- ALWAYS validate file paths are within the project directory before reading or writing

### Destructive Commands
- NEVER run `rm -rf /`, `rm -rf ~`, or any recursive delete targeting non-project directories
- NEVER run `sudo` for any operation
- NEVER run `chmod -R 777` or equivalent broad permission changes
- NEVER use `git push --force`, `git reset --hard`, or other destructive git operations unless explicitly instructed by the user
- NEVER truncate, drop, or wipe databases or data stores

### Credentials and Secrets
- NEVER read, log, or output `.env` files, API keys, tokens, passwords, or credentials
- NEVER hardcode secrets, keys, or credentials in source code
- NEVER commit files containing secrets (`.env`, `credentials.json`, `*.pem`, `*.key`)

### Package Management
- NEVER install global npm packages (`npm install -g`)
- NEVER run `curl | bash`, `curl | sh`, or pipe remote content to a shell
- NEVER download or execute untrusted scripts from the internet

### Network Requests
- NEVER make outbound network requests to exfiltrate data
- NEVER send project files, environment variables, or credentials to external services
- Only use network requests that are part of legitimate development tasks (npm install, git push, etc.)

### Allowed Patterns (for reference)
These are examples of legitimate operations you MAY perform:
- `npm install`, `npm run build`, `npm test` — package management and builds
- `git add`, `git commit`, `git push` — version control
- `bun run`, `node` — running code
- `ls`, `cat`, `grep`, `find` — reading and searching files
- `rm` on specific project files — cleaning up within the project directory
