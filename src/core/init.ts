/**
 * Init command — bootstraps agent-cli scaffold files in a target directory
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fileExists, writeText, copyFileTo, ensureDir } from '../utils/file-utils.js';
import { info, success, warn } from '../utils/logger.js';

/** Template PRD with placeholder values */
const TEMPLATE_PRD = {
  project: "Your Project Name",
  branchName: "feature/your-feature",
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
};

/**
 * Run the init process — copy scaffold files to the target directory
 */
export async function runInit(targetDir: string): Promise<void> {
  info(`Initializing agent-cli in: ${targetDir}`);

  await ensureDir(targetDir);

  // Resolve the package root (where agent-cli.md lives)
  const __filename = fileURLToPath(import.meta.url);
  const packageRoot = join(dirname(__filename), '../..');
  const sourceAgentCliMd = join(packageRoot, 'agent-cli.md');

  // Copy agent-cli.md
  const destAgentCliMd = join(targetDir, 'agent-cli.md');
  await copyFileTo(sourceAgentCliMd, destAgentCliMd);
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
    await writeText(destPrd, JSON.stringify(TEMPLATE_PRD, null, 2));
    success('  Created template prd.json');
  }

  success('Init complete!');
}
