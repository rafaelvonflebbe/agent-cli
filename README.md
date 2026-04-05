# Agent CLI

An autonomous loop that uses AI tools (amp or claude) to implement user stories defined in a PRD (`prd.json`). It runs iterations until all stories are complete or the iteration limit is reached.

## How it works

1. You create a `prd.json` file in your project directory with the user stories to implement
2. Agent CLI reads the PRD, finds the highest priority story with `passes: false`
3. It invokes the AI tool (amp or claude), feeding it instructions from `CLAUDE.md` (or `prompt.md`)
4. The AI tool implements the story and, upon completion, sets `passes: true` in the PRD
5. The loop repeats for the next story
6. When all stories are complete, the AI tool emits `<promise>COMPLETE</promise>` and the loop ends

## Installation

```bash
npm install
npm run build
npm link  # Optional: to use `agent-cli` globally
```

## Basic usage

```bash
# In your project directory (where prd.json is located)
agent-cli

# Specify tool and maximum iterations
agent-cli --tool claude 15

# Point to another directory
agent-cli --directory /path/to/project --tool amp 10
```

| Option | Description | Default |
|--------|-------------|---------|
| `[max_iterations]` | Maximum number of iterations | `10` |
| `--tool <amp\|claude>` | AI tool to use | `claude` |
| `--directory <path>` | Working directory | Current directory |
| `--dry-run` | Simulates the loop without spawning external tools | `false` |

## Using in another project

To use Agent CLI in your own project, you need **two files** in the project directory:

### 1. `prd.json` — Required

Defines the stories that the AI should implement:

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
    },
    {
      "id": "US-002",
      "title": "Add integration tests",
      "description": "Tests for the login endpoint",
      "acceptanceCriteria": [
        "Tests cover success and failure cases"
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    }
  ]
}
```

**Fields:**
- `priority`: lower number = higher priority (runs first)
- `passes`: `false` = pending, `true` = completed
- `branchName`: when changed, Agent CLI automatically archives the previous run

### 2. `CLAUDE.md` or `prompt.md` — Required

Instructions that the AI tool will receive. Use `CLAUDE.md` for claude, `prompt.md` for amp.

The file should instruct the AI to:
1. Read `prd.json`
2. Pick the highest priority story where `passes: false`
3. Implement that story
4. If tests pass, update `passes: true` in the PRD
5. If all stories are complete, emit `<promise>COMPLETE</promise>`

Minimal `CLAUDE.md` example:

```markdown
You are a development agent.

1. Read prd.json
2. Pick the highest priority story where passes: false
3. Implement that story
4. If it works, update passes: true in prd.json
5. If all stories are complete, respond: <promise>COMPLETE</promise>
```

### Complete example

```bash
# In your project
cd /my-project

# Make sure the files exist
ls prd.json CLAUDE.md

# Run with claude
agent-cli --tool claude 20

# Or run with amp
agent-cli --tool amp 10

# Simulate the loop without spawning tools (for testing)
agent-cli --dry-run 5
```

## Auto-archiving

When the `branchName` in the PRD changes between runs, Agent CLI archives the previous state in:

```
archive/YYYY-MM-DD-feature-name/
  ├── prd.json
  └── progress.log
```

## Termination

The loop ends when:
- All stories have `passes: true`, OR
- The maximum number of iterations is reached

## Development

This project uses **Bun** as its primary runtime, which compiles and runs TypeScript natively with no separate build step.

```bash
npm run dev        # Run directly with Bun (recommended)
npm run build      # Bundle with bun build to dist/
npm run build:old  # Build with tsgo (fallback)
npm run build:tsc  # Build with standard tsc (fallback)
npm run watch      # Compile in watch mode with tsc
```

Requires Node >= 20.
