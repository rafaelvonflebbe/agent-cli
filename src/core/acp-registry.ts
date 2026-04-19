/**
 * ACP Provider Registry — manages available ACP agent adapters.
 *
 * Built-in providers (Claude, Codex, Copilot, Gemini) are registered by default.
 * Users can add custom providers via ~/.agent-cli/providers.json.
 *
 * The CLI --tool flag maps to provider names (e.g. --tool codex).
 * For each provider, the registry can check if the adapter is installed and
 * suggest an install command if not.
 */

import { homedir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { readJSON, writeJSON, fileExists, ensureDir } from '../utils/file-utils.js';
import { info } from '../utils/logger.js';
import type { ACPProvider, ProvidersConfig } from './types.js';

export type { ACPProvider, ProvidersConfig } from './types.js';

// ---------------------------------------------------------------------------
// Built-in providers
// ---------------------------------------------------------------------------

const BUILTIN_PROVIDERS: ACPProvider[] = [
  {
    name: 'claude',
    command: 'npx',
    args: ['@agentclientprotocol/claude-agent-acp'],
    capabilities: { fs: true, terminal: true },
    installHint: 'npm install -g @agentclientprotocol/claude-agent-acp',
    defaultMcpServers: [
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      },
    ],
  },
  {
    name: 'codex',
    command: 'npx',
    args: ['@zed-industries/codex-acp'],
    capabilities: { fs: true, terminal: true },
    installHint: 'npm install -g @zed-industries/codex-acp',
    defaultMcpServers: [
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      },
    ],
  },
  {
    name: 'copilot',
    command: 'npx',
    args: ['@github/copilot', '--acp'],
    capabilities: { fs: true, terminal: true },
    installHint: 'npm install -g @github/copilot',
  },
  {
    name: 'gemini',
    command: 'npx',
    args: ['@google/gemini-cli', '--acp'],
    capabilities: { fs: true, terminal: true },
    installHint: 'npm install -g @google/gemini-cli',
  },
];

// ---------------------------------------------------------------------------
// Config file helpers
// ---------------------------------------------------------------------------

const CONFIG_DIR = () => resolve(homedir(), '.agent-cli');
const PROVIDERS_PATH = () => resolve(CONFIG_DIR(), 'providers.json');

const EMPTY_CONFIG: ProvidersConfig = { providers: [] };

async function ensureProvidersConfig(): Promise<void> {
  await ensureDir(CONFIG_DIR());
  if (!(await fileExists(PROVIDERS_PATH()))) {
    await writeJSON(PROVIDERS_PATH(), EMPTY_CONFIG);
  }
}

async function loadProvidersConfig(): Promise<ProvidersConfig> {
  await ensureProvidersConfig();
  try {
    return await readJSON<ProvidersConfig>(PROVIDERS_PATH());
  } catch {
    return EMPTY_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// ACPProviderRegistry class
// ---------------------------------------------------------------------------

export class ACPProviderRegistry {
  private providers: Map<string, ACPProvider> = new Map();

  constructor() {
    for (const provider of BUILTIN_PROVIDERS) {
      this.providers.set(provider.name, provider);
    }
  }

  /**
   * Load user-defined custom providers from ~/.agent-cli/providers.json.
   * Custom providers override built-in providers with the same name.
   */
  async loadCustomProviders(): Promise<void> {
    const config = await loadProvidersConfig();
    for (const provider of config.providers) {
      this.providers.set(provider.name, provider);
    }
    if (config.providers.length > 0) {
      info(`ACP Registry: Loaded ${config.providers.length} custom provider(s) from ${PROVIDERS_PATH()}`);
    }
  }

  /**
   * Save custom providers to ~/.agent-cli/providers.json.
   * This replaces all custom providers — built-in providers are never written to disk.
   */
  async saveCustomProviders(providers: ACPProvider[]): Promise<void> {
    const config: ProvidersConfig = { providers };
    await ensureProvidersConfig();
    await writeJSON(PROVIDERS_PATH(), config);

    // Reload into the registry
    this.providers.clear();
    for (const provider of BUILTIN_PROVIDERS) {
      this.providers.set(provider.name, provider);
    }
    for (const provider of providers) {
      this.providers.set(provider.name, provider);
    }
  }

  /**
   * Get a provider by name.
   * Returns undefined if not found.
   */
  getProvider(name: string): ACPProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Check if a provider with the given name is registered.
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Get all registered provider names.
   */
  getProviderNames(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Get all registered providers.
   */
  getAllProviders(): ACPProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Get the built-in provider names (not custom).
   */
  getBuiltinProviderNames(): string[] {
    return BUILTIN_PROVIDERS.map(p => p.name);
  }

  /**
   * Register a provider at runtime (does not persist to disk).
   */
  register(provider: ACPProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Check if a provider's adapter is installed and available.
   *
   * For providers using `npx`, this checks if the npm package exists by
   * running the adapter with --version or --help. For direct commands,
   * checks if the command is on PATH.
   */
  async isAvailable(name: string): Promise<boolean> {
    const provider = this.providers.get(name);
    if (!provider) return false;

    return checkProviderAvailability(provider);
  }

  /**
   * Get an install suggestion for a provider whose adapter is not installed.
   * Returns undefined if the provider is unknown or has no install hint.
   */
  getInstallHint(name: string): string | undefined {
    const provider = this.providers.get(name);
    return provider?.installHint;
  }

  /**
   * Resolve a provider and check availability.
   * Throws with a helpful install suggestion if not available.
   */
  async resolve(name: string): Promise<ACPProvider> {
    const provider = this.providers.get(name);
    if (!provider) {
      const available = this.getProviderNames().join(', ');
      throw new Error(`Unknown ACP provider: '${name}'. Available providers: ${available}`);
    }

    const available = await checkProviderAvailability(provider);
    if (!available) {
      const hint = provider.installHint ?? 'Install the adapter package';
      throw new Error(
        `ACP provider '${name}' adapter is not installed. ${hint}`,
      );
    }

    return provider;
  }
}

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

/**
 * Check if a provider's adapter is available by attempting to run it.
 * Uses a short timeout to avoid blocking on missing packages.
 */
async function checkProviderAvailability(provider: ACPProvider): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(provider.command, [...provider.args, '--version'], {
      stdio: 'ignore',
      shell: false,
      timeout: 10_000,
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(false);
    }, 10_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Singleton & factory
// ---------------------------------------------------------------------------

let _instance: ACPProviderRegistry | null = null;

/**
 * Get the global ACP provider registry singleton.
 * Loads custom providers from disk on first call.
 */
export async function getACPRegistry(): Promise<ACPProviderRegistry> {
  if (!_instance) {
    _instance = new ACPProviderRegistry();
    await _instance.loadCustomProviders();
  }
  return _instance;
}

/**
 * Reset the singleton (useful for testing).
 */
export function resetACPRegistry(): void {
  _instance = null;
}

/**
 * Create a fresh ACP provider registry instance (no singleton).
 */
export function createACPRegistry(): ACPProviderRegistry {
  return new ACPProviderRegistry();
}
