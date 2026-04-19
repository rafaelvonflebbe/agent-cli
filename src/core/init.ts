/**
 * Init command — bootstraps agent-cli scaffold files in a target directory
 */

import { join, resolve } from 'path';
import { fileExists, writeText, copyFileTo, ensureDir } from '../utils/file-utils.js';
import { info, success, warn } from '../utils/logger.js';
import { getCurrentBranch } from '../utils/git-utils.js';
import { ensureGlobalAgentCliMd } from './prompt-resolver.js';

/** Template PRD with placeholder values */
const TEMPLATE_PRD = {
  project: "Your Project Name",
  branchName: "main",
  description: "Describe what this project does",
  userStories: [
    {
      id: "US-001",
      title: "Example user story",
      description: "Describe what needs to be implemented",
      acceptanceCriteria: [
        "Criterion 1",
        "Criterion 2",
      ],
      priority: 1,
      passes: false,
      notes: "",
    },
  ],
  // stopWhen: {
  //   stories: ["US-001"],
  //   maxCostUsd: 5.0,
  //   maxDurationMinutes: 30,
  // },
};

/**
 * Run the init process — copy scaffold files to the target directory
 */
export async function runInit(targetDir: string, projectDirectory?: string): Promise<void> {
  info(`Initializing agent-cli in: ${targetDir}`);

  await ensureDir(targetDir);

  // Ensure the global ~/.agent-cli/agent-cli.md template exists (auto-created if missing)
  const globalAgentCliMd = await ensureGlobalAgentCliMd();

  // Copy agent-cli.md from global template to project directory
  const destAgentCliMd = join(targetDir, 'agent-cli.md');
  await copyFileTo(globalAgentCliMd, destAgentCliMd);
  success('  Created agent-cli.md');

  // Create progress.log with standard header
  const destProgress = join(targetDir, 'progress.log');
  const header = `# Agent CLI Progress Log\nStarted: ${new Date().toISOString()}\n---\n`;
  await writeText(destProgress, header);
  success('  Created progress.log');

  // Handle prd.json — skip if it already exists
  const destPrd = join(targetDir, 'prd.json');
  if (await fileExists(destPrd)) {
    warn('  prd.json already exists — skipping (will not overwrite)');
  } else {
    const prd = { ...TEMPLATE_PRD };

    // Detect current git branch from the working directory
    const gitDir = projectDirectory ? resolve(projectDirectory) : targetDir;
    const currentBranch = await getCurrentBranch(gitDir);
    if (currentBranch) {
      prd.branchName = currentBranch;
    } else {
      prd.branchName = 'main';
    }

    if (projectDirectory) {
      // Resolve to absolute path so it works regardless of where agent-cli is run from
      (prd as Record<string, unknown>).projectDirectory = resolve(projectDirectory);
    }
    await writeText(destPrd, JSON.stringify(prd, null, 2));
    success(`  Created template prd.json (branch: ${prd.branchName})`);
  }

  success('Init complete!');
}
