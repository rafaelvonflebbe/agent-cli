/**
 * MCP Server Configuration — loading, resolving, and converting MCP servers
 * for ACP session creation.
 *
 * MCP servers can be configured at three levels (later entries override earlier):
 * 1. Provider defaults — built into each ACP provider in the registry
 * 2. Project-level config — in prd.json's `mcpServers` field
 * 3. Project-level override file — `.agent-cli/mcp-servers.json`
 *
 * The resolved list is converted from the simplified McpServerConfig format
 * (with `env: Record<string, string>`) to the ACP SDK's McpServer format
 * (with `env: EnvVariable[]`).
 */

import { join } from 'path';
import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServerConfig, PRD, ACPProvider } from './types.js';
import { readJSON, fileExists, ensureDir } from '../utils/file-utils.js';
import { info, debug, warn } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Config file format
// ---------------------------------------------------------------------------

/**
 * Project-level MCP server config file stored at `.agent-cli/mcp-servers.json`.
 */
export interface McpServersConfigFile {
  /** MCP server configurations */
  servers: McpServerConfig[];
}

// ---------------------------------------------------------------------------
// Conversion: McpServerConfig → ACP SDK McpServer (stdio)
// ---------------------------------------------------------------------------

/**
 * Convert a simplified McpServerConfig to the ACP SDK's McpServer (stdio) format.
 * The ACP SDK requires `env` as `Array<{ name: string; value: string }>`,
 * while our config uses `Record<string, string>` for ergonomics.
 */
export function toAcpMcpServer(config: McpServerConfig): McpServer {
  const env = config.env
    ? Object.entries(config.env).map(([name, value]) => ({ name, value }))
    : [];

  return {
    name: config.name,
    command: config.command,
    args: config.args,
    env,
  };
}

/**
 * Convert an array of McpServerConfig to ACP SDK McpServer[].
 */
export function toAcpMcpServers(configs: McpServerConfig[]): McpServer[] {
  return configs.map(toAcpMcpServer);
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const MCP_CONFIG_DIR = '.agent-cli';
const MCP_CONFIG_FILE = 'mcp-servers.json';

/**
 * Load MCP server configs from the project-level override file
 * (`.agent-cli/mcp-servers.json` in the project directory).
 * Returns an empty array if the file doesn't exist.
 */
export async function loadProjectMcpConfig(projectDir: string): Promise<McpServerConfig[]> {
  const configPath = join(projectDir, MCP_CONFIG_DIR, MCP_CONFIG_FILE);

  if (!(await fileExists(configPath))) {
    return [];
  }

  try {
    const config = await readJSON<McpServersConfigFile>(configPath);
    if (config.servers && Array.isArray(config.servers)) {
      info(`MCP: Loaded ${config.servers.length} server(s) from ${configPath}`);
      return config.servers;
    }
    warn(`MCP: Invalid config format in ${configPath} — expected { "servers": [...] }`);
    return [];
  } catch (err) {
    warn(`MCP: Failed to load ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Save MCP server configs to the project-level override file.
 */
export async function saveProjectMcpConfig(
  projectDir: string,
  servers: McpServerConfig[],
): Promise<void> {
  const configDir = join(projectDir, MCP_CONFIG_DIR);
  await ensureDir(configDir);

  const configPath = join(configDir, MCP_CONFIG_FILE);
  const config: McpServersConfigFile = { servers };
  const { writeJSON } = await import('../utils/file-utils.js');
  await writeJSON(configPath, config);
  info(`MCP: Saved ${servers.length} server(s) to ${configPath}`);
}

// ---------------------------------------------------------------------------
// Resolution: merge all config sources
// ---------------------------------------------------------------------------

export interface McpResolveOptions {
  /** The PRD (may contain mcpServers) */
  prd: PRD;
  /** The ACP provider (may have defaultMcpServers) */
  provider?: ACPProvider;
  /** Working directory containing prd.json */
  projectDir: string;
}

/**
 * Resolve the final list of MCP server configs for a session.
 *
 * Merge order (later entries override earlier by name):
 * 1. Provider defaults
 * 2. PRD-level mcpServers
 * 3. Project-level `.agent-cli/mcp-servers.json`
 *
 * Returns configs in the simplified McpServerConfig format.
 * Use `toAcpMcpServers()` to convert for ACP session creation.
 */
export async function resolveMcpServers(
  options: McpResolveOptions,
): Promise<McpServerConfig[]> {
  const merged = new Map<string, McpServerConfig>();

  // 1. Provider defaults
  if (options.provider?.defaultMcpServers) {
    for (const server of options.provider.defaultMcpServers) {
      merged.set(server.name, server);
    }
    debug(`MCP: Loaded ${options.provider.defaultMcpServers.length} provider default server(s)`);
  }

  // 2. PRD-level mcpServers
  if (options.prd.mcpServers) {
    for (const server of options.prd.mcpServers) {
      merged.set(server.name, server);
    }
    debug(`MCP: Loaded ${options.prd.mcpServers.length} PRD-level server(s)`);
  }

  // 3. Project-level override file
  const projectServers = await loadProjectMcpConfig(options.projectDir);
  for (const server of projectServers) {
    merged.set(server.name, server);
  }

  const servers = [...merged.values()];

  if (servers.length > 0) {
    const names = servers.map(s => s.name).join(', ');
    info(`MCP: Resolved ${servers.length} server(s) for session: ${names}`);
  } else {
    debug('MCP: No MCP servers configured');
  }

  return servers;
}

/**
 * Convenience: resolve MCP servers and convert to ACP SDK format in one call.
 */
export async function resolveAcpMcpServers(
  options: McpResolveOptions,
): Promise<McpServer[]> {
  const configs = await resolveMcpServers(options);
  return toAcpMcpServers(configs);
}
