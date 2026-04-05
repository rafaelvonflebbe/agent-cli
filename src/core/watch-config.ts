/**
 * Global .watch.json config management
 */

import { homedir } from 'os';
import { resolve } from 'path';
import type { WatchConfig } from './types.js';
import { readJSON, writeJSON, fileExists, ensureDir } from '../utils/file-utils.js';
import { success, error, info } from '../utils/logger.js';

const CONFIG_DIR = () => resolve(homedir(), '.agent-cli');
const CONFIG_PATH = () => resolve(CONFIG_DIR(), '.watch.json');

const EMPTY_CONFIG: WatchConfig = { directories: [] };

/**
 * Ensure the config directory and file exist
 */
async function ensureConfig(): Promise<void> {
  await ensureDir(CONFIG_DIR());
  if (!(await fileExists(CONFIG_PATH()))) {
    await writeJSON(CONFIG_PATH(), EMPTY_CONFIG);
  }
}

/**
 * Load the watch config from disk
 */
export async function loadWatchConfig(): Promise<WatchConfig> {
  await ensureConfig();
  return readJSON<WatchConfig>(CONFIG_PATH());
}

/**
 * Save the watch config to disk
 */
export async function saveWatchConfig(config: WatchConfig): Promise<void> {
  await ensureConfig();
  await writeJSON(CONFIG_PATH(), config);
}

/**
 * Add a directory to the watch list. Resolves to absolute path.
 * @returns true if added, false if already present
 */
export async function addDirectory(inputPath: string): Promise<boolean> {
  const absPath = resolve(inputPath);
  const config = await loadWatchConfig();

  if (config.directories.includes(absPath)) {
    info(`Already watching: ${absPath}`);
    return false;
  }

  config.directories.push(absPath);
  await saveWatchConfig(config);
  success(`Added: ${absPath}`);
  return true;
}

/**
 * Remove a directory from the watch list. Resolves to absolute path.
 * @returns true if removed, false if not found
 */
export async function removeDirectory(inputPath: string): Promise<boolean> {
  const absPath = resolve(inputPath);
  const config = await loadWatchConfig();

  const idx = config.directories.indexOf(absPath);
  if (idx === -1) {
    error(`Not in watch list: ${absPath}`);
    return false;
  }

  config.directories.splice(idx, 1);
  await saveWatchConfig(config);
  success(`Removed: ${absPath}`);
  return true;
}

/**
 * List all watched directories
 */
export async function listDirectories(): Promise<void> {
  const config = await loadWatchConfig();

  if (config.directories.length === 0) {
    info('No directories configured. Use --add <path> to add one.');
    return;
  }

  info(`Watching ${config.directories.length} director${config.directories.length === 1 ? 'y' : 'ies'}:`);
  for (const dir of config.directories) {
    console.log(`  ${dir}`);
  }
}
