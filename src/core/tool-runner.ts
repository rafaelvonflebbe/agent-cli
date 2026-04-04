/**
 * Tool Runner - executes external AI CLI tools (amp/claude)
 */

import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import type { ToolResult, ToolType } from './types.js';
import { getToolCommand, getPromptFile } from './config.js';
import { join } from 'path';
import { info, error, iterationHeader } from '../utils/logger.js';
import { fileExistsSync } from '../utils/file-utils.js';
import chalk from 'chalk';

/**
 * Parse a single stream-json event line and display relevant output
 */
function handleStreamEvent(line: string): { completed: boolean; cost?: number; duration?: number } {
  let completed = false;
  let cost: number | undefined;
  let duration: number | undefined;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    // Not JSON — ignore
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
        const toolName = contentBlock.name as string | undefined;
        if (toolName) {
          const input = contentBlock.input as Record<string, unknown> | undefined;
          const detail = input && Object.keys(input).length > 0
            ? ` ${JSON.stringify(input)}`
            : '';
          process.stdout.write(chalk.magenta(`  Using: ${toolName}${detail}\n`));
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
        }
      } else if (deltaType === 'input_json_delta') {
        const partialJson = delta.partial_json as string | undefined;
        if (partialJson) {
          process.stdout.write(chalk.gray(partialJson));
        }
      }
      // thinking_delta is intentionally not displayed to reduce noise
    }
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
  }

  return { completed, cost, duration };
}

/**
 * Tool Runner class
 */
export class ToolRunner {
  private readonly directory: string;
  private readonly tool: ToolType;
  private readonly completionSignal: string;

  constructor(directory: string, tool: ToolType, completionSignal: string) {
    this.directory = directory;
    this.tool = tool;
    this.completionSignal = completionSignal;
  }

  /**
   * Run the AI tool
   */
  async run(iteration: number, maxIterations: number): Promise<ToolResult> {
    iterationHeader(iteration, maxIterations, this.tool);

    const promptFile = join(this.directory, getPromptFile(this.tool));

    // Check if prompt file exists
    if (!fileExistsSync(promptFile)) {
      throw new Error(`Prompt file not found: ${promptFile}`);
    }

    const { command, args } = getToolCommand(this.tool);

    info(`Running: ${command} ${args.join(' ')} < ${getPromptFile(this.tool)}`);

    // Spawn the process
    const proc = spawn(command, args, {
      cwd: this.directory,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Stream the prompt file to stdin
    const promptStream = createReadStream(promptFile);
    promptStream.pipe(proc.stdin!);

    // Collect output
    let stdout = '';
    let stderr = '';
    let completed = false;
    let totalCostUsd: number | undefined;
    let durationMs: number | undefined;

    if (this.tool === 'claude') {
      // Parse stream-json events line-by-line
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
          }
        }
      });
    } else {
      // amp: stream stdout raw to console and capture
      proc.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        process.stdout.write(chunk);
      });
    }

    // Stream stderr to console and capture
    proc.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    // Wait for process to complete
    return new Promise<ToolResult>((resolve) => {
      proc.on('close', (code, signal) => {
        // Fallback: also check raw stdout for the completion signal
        if (!completed) {
          completed = stdout.includes(this.completionSignal);
        }

        if (totalCostUsd !== undefined) {
          info(`Cost: $${totalCostUsd.toFixed(4)}`);
        }
        if (durationMs !== undefined) {
          info(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
        }

        const result: ToolResult = {
          exitCode: code,
          stdout,
          stderr,
          completed,
          signal: signal || null,
          totalCostUsd,
          durationMs,
        };

        resolve(result);
      });

      // Handle spawn errors
      proc.on('error', (err) => {
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
   * Check if the tool is available
   */
  async isAvailable(): Promise<boolean> {
    const { command } = getToolCommand(this.tool);

    return new Promise((resolve) => {
      const proc = spawn(command, ['--version'], {
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
  completionSignal: string
): ToolRunner {
  return new ToolRunner(directory, tool, completionSignal);
}
