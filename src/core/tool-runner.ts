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

    // Stream stdout to console and capture for completion detection
    proc.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      process.stdout.write(chunk);
    });

    // Stream stderr to console and capture
    proc.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    // Wait for process to complete
    return new Promise<ToolResult>((resolve) => {
      proc.on('close', (code, signal) => {
        const completed = stdout.includes(this.completionSignal);

        const result: ToolResult = {
          exitCode: code,
          stdout,
          stderr,
          completed,
          signal: signal || null,
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
