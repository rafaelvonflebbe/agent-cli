# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

- **Build:** `npm run build` — uses **tsgo** (`@typescript/native-preview`), the native Go-based TypeScript compiler (fast)
- **Build (fallback):** `npm run build:old` — standard `tsc` if tsgo has issues
- **Run:** `npm start` or `npm run dev` (tsgo build + run)
- **Watch:** `npm run watch` (standard `tsc --watch`)
- **Global install:** `npm link`

No test framework is configured.

## Architecture

Agent CLI is an autonomous loop that drives an AI tool (amp or claude) to iteratively implement user stories defined in a PRD.

**Entry point:** `src/index.ts` — CLI powered by `commander`. Parses `[max_iterations]`, `--tool`, `--directory` flags, validates that `prd.json` exists, then calls `runAgent()`.

**Core loop flow (`src/core/iterator.ts`):**
1. Load `prd.json` via `PRDManager`
2. Initialize archive system (creates `progress.txt` if missing)
3. Check if branch changed — if so, archive previous run
4. Iterate up to `maxIterations`: spawn the AI tool, stream its prompt file to stdin, capture stdout to detect `<promise>COMPLETE</promise>` signal
5. After each iteration, reload PRD to check if all stories have `passes: true`

**Key modules:**
- `src/core/tool-runner.ts` — Spawns `amp` or `claude` as child processes. Pipes the prompt file (`CLAUDE.md` for claude, `prompt.md` for amp) to stdin. Detects completion by scanning stdout for the signal string.
- `src/core/prd.ts` — `PRDManager` class: load/save/validate `prd.json`, track story completion, find next incomplete story by priority (lower number = higher priority).
- `src/core/archiver.ts` — When `branchName` in PRD changes, archives previous `prd.json` + `progress.txt` to `archive/YYYY-MM-DD-feature-name/`. Tracks last branch in `.last-branch`.
- `src/core/config.ts` — Defaults (tool: `amp`, maxIterations: `10`, delay: `2000ms`), validation, and tool command/args mapping.
- `src/core/types.ts` — All TypeScript interfaces: `PRD`, `UserStory`, `AgentConfig`, `ToolResult`, `ArchiveInfo`, etc.

**Utilities:** `src/utils/file-utils.ts` (JSON/text file I/O), `src/utils/logger.ts` (chalk-based colored logging with levels).

## PRD Format

The working directory must contain `prd.json` with: `project`, `branchName`, `description`, and `userStories[]` (each with `id`, `title`, `description`, `acceptanceCriteria[]`, `priority`, `passes`, `notes`).

## Conventions

- ESM-only (`"type": "module"`), ES2022 target, strict mode
- Factory functions (`createXxx`) alongside classes for each module
- Node >= 20
