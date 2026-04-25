/**
 * Configuration management for Agent CLI
 */

import type { AgentConfig, ToolType, ToolConfig, SandboxConfig, PermissionMode } from './types.js';
import { createACPRegistry, type ACPProvider } from './acp-registry.js';

/**
 * Create a fresh ACP registry instance for synchronous lookups.
 * Only includes built-in providers (not custom providers from disk).
 * Use getACPRegistry() for the full async-loaded registry.
 */
function createACPRegistryFresh() {
  return createACPRegistry();
}

export type { ToolType, ToolConfig, PermissionMode } from './types.js';

/**
 * Scoped permission allowlist — tools the agent is allowed to use in scoped mode.
 * Maps directly to --allowedTools flags passed to Claude Code.
 */
export const SCOPED_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash(npm *)',
  'Bash(git *)',
  'Bash(bun *)',
  'Bash(node *)',
  'Bash(ls *)',
  'Bash(rm *)',
] as const;

/**
 * Shared args used by all tools regardless of permission mode.
 */
const SHARED_ARGS = ['--output-format', 'stream-json', '--include-partial-messages', '--verbose'];

/**
 * Built-in tool registry: maps tool names to their configuration.
 * Add new tools by adding entries here.
 */
const TOOL_REGISTRY: Record<string, ToolConfig> = {
  claude: {
    command: 'claude',
    args: [...SHARED_ARGS],
    promptFile: 'agent-cli.md',
  },
  openclaude: {
    command: 'openclaude',
    args: [...SHARED_ARGS],
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
  permissionMode: 'scoped' as PermissionMode,
  sandbox: {
    image: 'agent-cli-runner',
    memory: '512m',
    cpu: '1.0',
  } satisfies SandboxConfig,
};

/**
 * Create an agent configuration with defaults applied
 */
export function createConfig(options: Partial<AgentConfig> = {}): AgentConfig {
  return {
    tool: options.tool ?? DEFAULTS.tool,
    directory: options.directory ?? process.cwd(),
    dataDirectory: options.dataDirectory,
    projectDirectory: options.projectDirectory,
    maxIterations: options.maxIterations ?? DEFAULTS.maxIterations,
    iterationDelay: options.iterationDelay ?? DEFAULTS.iterationDelay,
    completionSignal: options.completionSignal ?? DEFAULTS.completionSignal,
    dryRun: options.dryRun ?? false,
    maxStories: options.maxStories,
    resume: options.resume,
    sandbox: options.sandbox,
    permissionMode: options.permissionMode ?? DEFAULTS.permissionMode,
    acp: options.acp,
    storyIds: options.storyIds,
    extraPrompts: options.extraPrompts,
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
 * Check if a tool name is registered (legacy registry or ACP provider)
 */
export function isToolRegistered(tool: string): boolean {
  if (tool in TOOL_REGISTRY) return true;
  // Also check ACP providers — synchronous check via fresh instance
  const registry = createACPRegistryFresh();
  return registry.hasProvider(tool);
}

/**
 * Get the list of available (registered) tool names including ACP providers
 */
export function getAvailableToolNames(): string[] {
  const legacy = Object.keys(TOOL_REGISTRY);
  const registry = createACPRegistryFresh();
  const acpNames = registry.getProviderNames().filter(n => !legacy.includes(n));
  return [...legacy, ...acpNames];
}

/**
 * Check if a tool name refers to an ACP provider (not a legacy tool)
 */
export function isACPProvider(tool: string): boolean {
  if (tool in TOOL_REGISTRY) return false;
  const registry = createACPRegistryFresh();
  return registry.hasProvider(tool);
}

/**
 * Get the ACP provider for a tool name.
 * Returns undefined if the tool is a legacy tool or not found.
 */
export function getACPProvider(tool: string): ACPProvider | undefined {
  const registry = createACPRegistryFresh();
  return registry.getProvider(tool);
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
 * Get the command and arguments for a specific tool, with permission mode applied.
 * - 'yolo': adds --dangerously-skip-permissions
 * - 'scoped': adds --allowedTools for each entry in SCOPED_ALLOWED_TOOLS
 */
export function getToolCommand(tool: string, permissionMode: PermissionMode = 'scoped'): { command: string; args: string[] } {
  const config = getToolConfig(tool);
  const args = [...config.args];

  if (permissionMode === 'yolo') {
    args.unshift('--dangerously-skip-permissions');
  } else {
    // scoped mode: add --allowedTools for each allowed tool
    for (const allowed of SCOPED_ALLOWED_TOOLS) {
      args.push('--allowedTools', allowed);
    }
  }

  return { command: config.command, args };
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

/**
 * Get the default sandbox configuration
 */
export function getSandboxDefaults(): SandboxConfig {
  return { ...DEFAULTS.sandbox };
}
