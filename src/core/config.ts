/**
 * Configuration management for Agent CLI
 */

import type { AgentConfig, ToolType, ToolConfig } from './types.js';

export type { ToolType, ToolConfig } from './types.js';

/**
 * Built-in tool registry: maps tool names to their configuration.
 * Add new tools by adding entries here.
 */
const TOOL_REGISTRY: Record<string, ToolConfig> = {
  claude: {
    command: 'claude',
    args: ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'],
    promptFile: 'agent-cli.md',
  },
  openclaude: {
    command: 'openclaude',
    args: ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'],
    promptFile: 'agent-cli.md',
  },
};

/**
 * Default configuration values
 */
const DEFAULTS = {
  tool: 'claude' as ToolType,
  maxIterations: 10,
  iterationDelay: 2000,
  completionSignal: '<promise>COMPLETE</promise>',
  dryRun: false,
} satisfies Record<string, ToolType | number | string | boolean>;

/**
 * Create an agent configuration with defaults applied
 */
export function createConfig(options: Partial<AgentConfig> = {}): AgentConfig {
  return {
    tool: options.tool ?? DEFAULTS.tool,
    directory: options.directory ?? process.cwd(),
    maxIterations: options.maxIterations ?? DEFAULTS.maxIterations,
    iterationDelay: options.iterationDelay ?? DEFAULTS.iterationDelay,
    completionSignal: options.completionSignal ?? DEFAULTS.completionSignal,
    dryRun: options.dryRun ?? false,
    maxStories: options.maxStories,
    resume: options.resume,
  };
}

/**
 * Validate configuration
 * @throws Error if configuration is invalid
 */
export function validateConfig(config: AgentConfig): void {
  if (!isToolRegistered(config.tool)) {
    throw new Error(
      `Unknown tool: '${config.tool}'. Available tools: ${getAvailableToolNames().join(', ')}`
    );
  }

  if (config.maxIterations < 1) {
    throw new Error(`maxIterations must be at least 1, got ${config.maxIterations}`);
  }

  if (config.iterationDelay < 0) {
    throw new Error(`iterationDelay cannot be negative, got ${config.iterationDelay}`);
  }

  if (!config.completionSignal) {
    throw new Error('completionSignal cannot be empty');
  }
}

/**
 * Check if a tool name is registered
 */
export function isToolRegistered(tool: string): boolean {
  return tool in TOOL_REGISTRY;
}

/**
 * Get the list of available (registered) tool names
 */
export function getAvailableToolNames(): string[] {
  return Object.keys(TOOL_REGISTRY);
}

/**
 * Get the configuration for a registered tool
 * @throws Error if the tool is not registered
 */
export function getToolConfig(tool: string): ToolConfig {
  const config = TOOL_REGISTRY[tool];
  if (!config) {
    throw new Error(
      `Unknown tool: '${tool}'. Available tools: ${getAvailableToolNames().join(', ')}`
    );
  }
  return config;
}

/**
 * Get the command and arguments for a specific tool
 */
export function getToolCommand(tool: string): { command: string; args: string[] } {
  const config = getToolConfig(tool);
  return { command: config.command, args: [...config.args] };
}

/**
 * Get the prompt file name for a specific tool
 */
export function getPromptFile(tool: string): string {
  const config = getToolConfig(tool);
  return config.promptFile;
}

/**
 * Export defaults for reference
 */
export const DEFAULT_CONFIG = DEFAULTS;
