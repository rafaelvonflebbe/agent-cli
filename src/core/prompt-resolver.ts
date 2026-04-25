/**
 * Prompt file resolver — resolves the agent-cli.md prompt file path.
 *
 * Resolution order:
 *   1. Project-level: `<workDir>/agent-cli.md` (takes precedence)
 *   2. Global fallback: `~/.agent-cli/agent-cli.md` (auto-created from bundled template)
 */

import { homedir } from 'os';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fileExists, ensureDir, writeText, copyFileTo } from '../utils/file-utils.js';
import { info } from '../utils/logger.js';

/** Get the global config directory: ~/.agent-cli/ */
export function getGlobalConfigDir(): string {
  return resolve(homedir(), '.agent-cli');
}

/** Get the global prompt template path: ~/.agent-cli/agent-cli.md */
export function getGlobalAgentCliMd(): string {
  return join(getGlobalConfigDir(), 'agent-cli.md');
}

/**
 * Ensure the global ~/.agent-cli/agent-cli.md exists.
 * Creates it from the bundled template on first run if missing.
 * Returns the path to the global file.
 */
export async function ensureGlobalAgentCliMd(): Promise<string> {
  const globalPath = getGlobalAgentCliMd();
  if (await fileExists(globalPath)) {
    return globalPath;
  }

  // Resolve bundled template relative to this module
  const __filename = fileURLToPath(import.meta.url);
  const packageRoot = join(dirname(__filename), '../..');
  const bundledTemplate = join(packageRoot, 'agent-cli.md');

  if (await fileExists(bundledTemplate)) {
    await ensureDir(getGlobalConfigDir());
    await copyFileTo(bundledTemplate, globalPath);
    info(`Created global prompt template at ${globalPath}`);
  } else {
    // Fallback: create a minimal template if the bundled one is missing
    // (e.g. running from a bundled dist where the template wasn't included)
    const minimalTemplate = [
      'You are an autonomous development agent. Your job is to implement user stories from a PRD file.',
      '',
      '## Instructions',
      '',
      '1. Read `prd.json` in the current directory',
      '2. Find the story with the highest priority (lowest number) where `passes` is `false`',
      '3. Implement that story — write code, edit files, run builds as needed',
      '4. Verify your work against the story\'s `acceptanceCriteria`',
      '5. If all criteria are met, update the story\'s `passes` field to `true` in `prd.json`',
      '6. If all stories have `passes: true`, respond with exactly: `<promise>COMPLETE</promise>`',
      '7. If some stories remain incomplete, stop and wait for the next iteration',
      '',
      '## Rules',
      '',
      '- Only work on ONE story per iteration',
      '- Always verify the build passes (`npm run build`) before marking a story as complete',
      '- Update `prd.json` in place — do not rename or move it',
      '- Be thorough: read existing code before making changes',
      '- Follow existing code conventions and patterns in the project',
    ].join('\n');

    await ensureDir(getGlobalConfigDir());
    await writeText(globalPath, minimalTemplate);
    info(`Created minimal global prompt template at ${globalPath}`);
  }

  return globalPath;
}

/**
 * Resolve the prompt file path for a given working directory.
 *
 * Checks for a project-level `agent-cli.md` first.
 * If not found, falls back to the global `~/.agent-cli/agent-cli.md`
 * (auto-creating it from the bundled template if necessary).
 *
 * @returns Absolute path to the resolved prompt file
 * @throws Error if no prompt file can be resolved
 */
export async function resolvePromptFile(workDir: string): Promise<string> {
  // 1. Check .tmp/ subdirectory first (new layout)
  const tmpPrompt = join(workDir, '.tmp', 'agent-cli.md');
  if (await fileExists(tmpPrompt)) {
    return tmpPrompt;
  }

  // 2. Check project root (backward compat)
  const projectPrompt = join(workDir, 'agent-cli.md');
  if (await fileExists(projectPrompt)) {
    return projectPrompt;
  }

  // 3. Fall back to global (auto-created from bundled template if missing)
  const globalPath = await ensureGlobalAgentCliMd();
  return globalPath;
}
