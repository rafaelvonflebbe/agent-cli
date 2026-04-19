/**
 * Tool Runner - executes registered AI CLI tools
 */

import { spawn } from 'child_process';
import { createReadStream, createWriteStream, writeFileSync, mkdirSync, type WriteStream } from 'fs';
import type { ToolResult, ToolType, SandboxConfig, PermissionMode, TokenUsage } from './types.js';
import { getToolCommand, getToolConfig, SCOPED_ALLOWED_TOOLS } from './config.js';
import { join } from 'path';
import { info, error, iterationHeader } from '../utils/logger.js';
import { fileExistsSync } from '../utils/file-utils.js';
import { formatDuration } from '../utils/format-utils.js';
import { resolvePromptFile } from './prompt-resolver.js';
import chalk from 'chalk';

const AGENT_OUTPUT_LOG = '.agent-output.log';

/**
 * Format tool input into a human-readable summary instead of raw JSON.
 * Shows the most relevant parameter for each tool type.
 */
/**
 * Shorten a file path to show only from the project directory name onward.
 * e.g. "/Users/rafaelvonflebbe/genai-projects/agent-cli/src/index.ts" → "agent-cli/src/index.ts"
 */
function shortenPath(filePath: string): string {
  const cwd = process.cwd();
  const sep = cwd.includes('/') ? '/' : '\\';
  // Get the project folder name (last segment of cwd)
  const projectFolder = cwd.split(sep).pop() || '';
  const idx = filePath.indexOf(sep + projectFolder + sep);
  if (idx !== -1) {
    return filePath.slice(idx + 1);
  }
  // Fallback: if it's under cwd, show relative path
  if (filePath.startsWith(cwd + sep)) {
    return filePath.slice(cwd.length + 1);
  }
  return filePath;
}

/**
 * Format tool input into a human-readable summary instead of raw JSON.
 * Shows the most relevant parameter for each tool type.
 */
function formatToolInput(_toolName: string, input: Record<string, unknown>): string {
  // Tools that operate on files — show the file path (shortened)
  if ('file_path' in input) {
    return ` ${shortenPath(String(input.file_path))}`;
  }

  // Tools that search — show the pattern/query
  if ('pattern' in input) {
    return ` "${input.pattern}"`;
  }
  if ('query' in input) {
    return ` "${input.query}"`;
  }

  // Agent tool — show description
  if ('description' in input && typeof input.description === 'string') {
    return ` — ${input.description}`;
  }

  // Task/TodoWrite — show subject or count
  if ('subject' in input) {
    return ` ${input.subject}`;
  }
  if ('todos' in input && Array.isArray(input.todos)) {
    return ` (${input.todos.length} items)`;
  }

  // Bash — show the command
  if ('command' in input) {
    const cmd = String(input.command);
    const preview = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    return ` ${preview}`;
  }

  // Notebook edit
  if ('notebook_path' in input) {
    return ` ${shortenPath(String(input.notebook_path))}`;
  }

  // Fallback — show first string value (shorten if it looks like a path)
  const firstVal = Object.values(input).find(v => typeof v === 'string' && v.length > 0);
  if (firstVal) {
    let preview = String(firstVal);
    if (preview.startsWith('/')) preview = shortenPath(preview);
    if (preview.length > 60) preview = preview.slice(0, 57) + '...';
    return ` ${preview}`;
  }

  return '';
}

/**
 * Parse a single stream-json event line and display relevant output.
 * Accumulates input_json_delta fragments and displays a formatted summary
 * when the content block ends (content_block_stop), so tool args like
 * file_path are available even when they arrive incrementally.
 */
function createStreamEventHandler(logStream?: WriteStream) {
  let currentToolName: string | null = null;
  let inputJsonBuffer = '';

  return function handleStreamEvent(line: string): { completed: boolean; cost?: number; duration?: number; tokenUsage?: TokenUsage } {
    let completed = false;
    let cost: number | undefined;
    let duration: number | undefined;
    let tokenUsage: TokenUsage | undefined;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return { completed: false };
    }

    const eventType = event.type as string | undefined;

    if (eventType === 'stream_event') {
      const streamEvent = event.event as Record<string, unknown> | undefined;
      if (!streamEvent) return { completed: false };

      const seType = streamEvent.type as string | undefined;

      if (seType === 'content_block_start') {
        const contentBlock = streamEvent.content_block as Record<string, unknown> | undefined;
        if (contentBlock?.type === 'tool_use') {
          currentToolName = (contentBlock.name as string) || null;
          inputJsonBuffer = '';
          // If input already has content (rare but possible), use it
          const input = contentBlock.input as Record<string, unknown> | undefined;
          if (input && Object.keys(input).length > 0) {
            inputJsonBuffer = JSON.stringify(input);
          }
        }
      } else if (seType === 'content_block_delta') {
        const delta = streamEvent.delta as Record<string, unknown> | undefined;
        if (!delta) return { completed: false };
        const deltaType = delta.type as string | undefined;

        if (deltaType === 'text_delta') {
          const text = delta.text as string | undefined;
          if (text) {
            process.stdout.write(text);
            logStream?.write(text);
          }
        } else if (deltaType === 'input_json_delta') {
          // Accumulate JSON fragments silently
          const partialJson = delta.partial_json as string | undefined;
          if (partialJson) {
            inputJsonBuffer += partialJson;
          }
        }
      } else if (seType === 'content_block_stop') {
        // Tool input is complete — parse and display formatted summary
        if (currentToolName) {
          let input: Record<string, unknown> | undefined;
          try {
            if (inputJsonBuffer) {
              input = JSON.parse(inputJsonBuffer);
            }
          } catch {
            // Malformed JSON — skip detail
          }
          const detail = input ? formatToolInput(currentToolName, input) : '';
          const toolMsg = `  Using: ${currentToolName}${detail}\n`;
          process.stdout.write(chalk.magenta(toolMsg));
          logStream?.write(toolMsg);
          currentToolName = null;
          inputJsonBuffer = '';
        }
      }
      // thinking_delta is intentionally not displayed to reduce noise
    } else if (eventType === 'result') {
      const resultText = event.result as string | undefined;
      if (resultText?.includes('<promise>COMPLETE</promise>')) {
        completed = true;
      }

      if (event.total_cost_usd !== undefined) {
        cost = Number(event.total_cost_usd);
      }
      if (event.duration_ms !== undefined) {
        duration = Number(event.duration_ms);
      }

      // Capture token usage from stream-json result event
      const inputTokens = event.input_tokens as number | undefined;
      const outputTokens = event.output_tokens as number | undefined;
      const cacheCreation = event.cache_creation_input_tokens as number | undefined;
      const cacheRead = event.cache_read_input_tokens as number | undefined;
      if (inputTokens !== undefined || outputTokens !== undefined) {
        tokenUsage = {
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          cacheCreationInputTokens: cacheCreation ?? 0,
          cacheReadInputTokens: cacheRead ?? 0,
        };
      }
    }

    return { completed, cost, duration, tokenUsage };
  };
}

/**
 * Tool Runner class
 */
export class ToolRunner {
  private readonly directory: string;
  private readonly projectDirectory: string;
  private readonly tool: ToolType;
  private readonly completionSignal: string;
  private readonly sandbox?: SandboxConfig;
  private readonly permissionMode: PermissionMode;

  constructor(directory: string, tool: ToolType, completionSignal: string, sandbox?: SandboxConfig, permissionMode: PermissionMode = 'scoped', projectDirectory?: string) {
    this.directory = directory;
    this.projectDirectory = projectDirectory || directory;
    this.tool = tool;
    this.completionSignal = completionSignal;
    this.sandbox = sandbox;
    this.permissionMode = permissionMode;
  }

  /**
   * Run the AI tool
   */
  async run(iteration: number, maxIterations: number, options?: { promptSuffix?: string }): Promise<ToolResult> {
    iterationHeader(iteration, maxIterations, this.tool);

    // Create log file for real-time agent output
    const logPath = join(this.directory, AGENT_OUTPUT_LOG);
    const logStream = createWriteStream(logPath, { flags: 'w' });
    logStream.write(`--- Iteration ${iteration}/${maxIterations} (${this.tool}) ---\n`);

    const promptFile = await resolvePromptFile(this.directory);

    // Check if prompt file exists
    if (!fileExistsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }

    // Generate .claude/settings.json for scoped mode
    if (this.permissionMode === 'scoped') {
      this.ensureSettingsJson();
    }

    const { command, args } = getToolCommand(this.tool, this.permissionMode);
    const toolConfig = getToolConfig(this.tool);
    const usesStreamJson = toolConfig.args.includes('stream-json');

    let spawnCommand: string;
    let spawnArgs: string[];

    if (this.sandbox) {
      // Build docker run command
      const dockerArgs = [
        'run',
        '--rm',
        '-i', // interactive: keep stdin open for prompt piping
        '-v', `${this.projectDirectory}:/workspace`,
        '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      ];

      if (this.sandbox.memory) {
        dockerArgs.push('--memory', this.sandbox.memory);
      }
      if (this.sandbox.cpu) {
        dockerArgs.push('--cpus', this.sandbox.cpu);
      }

      dockerArgs.push(this.sandbox.image);
      dockerArgs.push(command, ...args);

      spawnCommand = 'docker';
      spawnArgs = dockerArgs;
      info(`Running (sandboxed): docker ${dockerArgs.join(' ')} < ${promptFile}`);
    } else {
      spawnCommand = command;
      spawnArgs = args;
      info(`Running: ${command} ${args.join(' ')} < ${promptFile}`);
    }

    // Spawn the process
    const proc = spawn(spawnCommand, spawnArgs, {
      cwd: this.projectDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Stream the prompt file to stdin, optionally appending a directive suffix
    const promptStream = createReadStream(promptFile);
    if (options?.promptSuffix) {
      promptStream.pipe(proc.stdin!, { end: false });
      promptStream.on('end', () => {
        proc.stdin!.end(options.promptSuffix!);
      });
    } else {
      promptStream.pipe(proc.stdin!);
    }

    // Collect output
    let stdout = '';
    let stderr = '';
    let completed = false;
    let totalCostUsd: number | undefined;
    let durationMs: number | undefined;
    let totalTokenUsage: TokenUsage | undefined;

    if (usesStreamJson) {
      // Parse stream-json events line-by-line
      const handleStreamEvent = createStreamEventHandler(logStream);
      let lineBuffer = '';
      proc.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        lineBuffer += chunk;

        // Process complete lines
        let newlineIdx: number;
        while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, newlineIdx).trim();
          lineBuffer = lineBuffer.slice(newlineIdx + 1);

          if (line) {
            const result = handleStreamEvent(line);
            if (result.completed) completed = true;
            if (result.cost !== undefined) totalCostUsd = result.cost;
            if (result.duration !== undefined) durationMs = result.duration;
            if (result.tokenUsage) {
              if (!totalTokenUsage) {
                totalTokenUsage = result.tokenUsage;
              } else {
                totalTokenUsage.inputTokens += result.tokenUsage.inputTokens;
                totalTokenUsage.outputTokens += result.tokenUsage.outputTokens;
                totalTokenUsage.cacheCreationInputTokens += result.tokenUsage.cacheCreationInputTokens;
                totalTokenUsage.cacheReadInputTokens += result.tokenUsage.cacheReadInputTokens;
              }
            }
          }
        }
      });
    } else {
      // Fallback: stream stdout raw to console and capture
      proc.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        process.stdout.write(chunk);
        logStream.write(chunk);
      });
    }

    // Stream stderr to console and capture
    proc.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      process.stderr.write(chunk);
      logStream.write(chunk);
    });

    // Wait for process to complete
    return new Promise<ToolResult>((resolve) => {
      proc.on('close', (code, signal) => {
        // Write cost/duration/token summary to log before closing
        if (totalCostUsd !== undefined) {
          logStream.write(`Cost: $${totalCostUsd.toFixed(4)}\n`);
        }
        if (durationMs !== undefined) {
          logStream.write(`Duration: ${formatDuration(durationMs)}\n`);
        }
        if (totalTokenUsage) {
          const total = totalTokenUsage.inputTokens + totalTokenUsage.cacheReadInputTokens + totalTokenUsage.cacheCreationInputTokens;
          logStream.write(`Tokens: ${total} input, ${totalTokenUsage.outputTokens} output, ${totalTokenUsage.cacheReadInputTokens} cache read, ${totalTokenUsage.cacheCreationInputTokens} cache write\n`);
        }
        logStream.end();

        // Fallback: also check raw stdout for the completion signal
        if (!completed) {
          completed = stdout.includes(this.completionSignal);
        }

        if (totalCostUsd !== undefined) {
          info(`Cost: $${totalCostUsd.toFixed(4)}`);
        }
        if (durationMs !== undefined) {
          info(`Duration: ${formatDuration(durationMs)}`);
        }
        if (totalTokenUsage) {
          info(`Tokens: ${totalTokenUsage.inputTokens} input, ${totalTokenUsage.outputTokens} output, ${totalTokenUsage.cacheReadInputTokens} cache read, ${totalTokenUsage.cacheCreationInputTokens} cache write`);
        }

        const result: ToolResult = {
          exitCode: code,
          stdout,
          stderr,
          completed,
          signal: signal || null,
          totalCostUsd,
          durationMs,
          tokenUsage: totalTokenUsage,
        };

        resolve(result);
      });

      // Handle spawn errors
      proc.on('error', (err) => {
        logStream.end();
        error(`Failed to spawn ${command}: ${err.message}`);

        resolve({
          exitCode: -1,
          stdout: '',
          stderr: err.message,
          completed: false,
          signal: null,
        });
      });
    });
  }

  /**
   * Ensure .claude/settings.json exists with the scoped allowlist.
   * This is read by Claude Code when --allowedTools is used.
   */
  private ensureSettingsJson(): void {
    // Write to projectDirectory so the spawned Claude Code (cwd=projectDirectory) can find it
    const claudeDir = join(this.projectDirectory, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');

    if (fileExistsSync(settingsPath)) {
      return; // Don't overwrite existing settings
    }

    if (!fileExistsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const allowedTools = [...SCOPED_ALLOWED_TOOLS];
    const settings = {
      permissions: {
        allow: allowedTools,
      },
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    info(`Generated scoped permission settings at ${settingsPath}`);
  }

  /**
   * Check if the tool is available (or docker is available when sandboxed)
   */
  async isAvailable(): Promise<boolean> {
    const checkCommand = this.sandbox ? 'docker' : getToolConfig(this.tool).command;
    const checkArgs = ['--version'];

    return new Promise((resolve) => {
      const proc = spawn(checkCommand, checkArgs, {
        stdio: 'ignore',
        shell: false,
      });

      proc.on('close', (code) => {
        resolve(code === 0);
      });

      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Get the tool name
   */
  getToolName(): string {
    return this.tool;
  }
}

/**
 * Create a tool runner instance
 */
export function createToolRunner(
  directory: string,
  tool: ToolType,
  completionSignal: string,
  sandbox?: SandboxConfig,
  permissionMode: PermissionMode = 'scoped',
  projectDirectory?: string
): ToolRunner {
  return new ToolRunner(directory, tool, completionSignal, sandbox, permissionMode, projectDirectory);
}
