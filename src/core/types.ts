/**
 * Core TypeScript interfaces for the Agent CLI
 */

/**
 * A single user story in the PRD
 */
export interface UserStory {
  /** Unique identifier (e.g., "US-001") */
  id: string;
  /** Human-readable title */
  title: string;
  /** Detailed description of the story */
  description: string;
  /** Acceptance criteria for completion */
  acceptanceCriteria: string[];
  /** Priority (lower = higher priority) */
  priority: number;
  /** Whether the story has been completed */
  passes: boolean;
  /** Additional notes or context */
  notes: string;
}

/**
 * Product Requirements Document structure
 */
export interface PRD {
  /** Project name */
  project: string;
  /** Git branch name for this feature */
  branchName: string;
  /** Feature description */
  description: string;
  /** User stories to implement */
  userStories: UserStory[];
}

/**
 * AI tool selection
 */
export type ToolType = 'amp' | 'claude';

/**
 * Result from running an AI tool
 */
export interface ToolResult {
  /** Process exit code (0 = success) */
  exitCode: number | null;
  /** Captured stdout */
  stdout: string;
  /** Captured stderr */
  stderr: string;
  /** Whether completion signal was detected */
  completed: boolean;
  /** Whether the process was terminated by a signal */
  signal: string | null;
}

/**
 * Configuration for the agent iterator
 */
export interface AgentConfig {
  /** AI tool to use */
  tool: ToolType;
  /** Working directory containing prd.json */
  directory: string;
  /** Maximum iterations to run */
  maxIterations: number;
  /** Delay between iterations (ms) */
  iterationDelay: number;
  /** Completion signal to detect */
  completionSignal: string;
}

/**
 * Archive information
 */
export interface ArchiveInfo {
  /** Path to archive directory */
  path: string;
  /** Feature name (branch name stripped of prefix) */
  featureName: string;
  /** Date of archive */
  date: Date;
}

/**
 * Result of checking archive status
 */
export interface ArchiveCheckResult {
  /** Whether archiving was performed */
  archived: boolean;
  /** Archive information if archived */
  archive?: ArchiveInfo;
  /** Previous branch name if changed */
  previousBranch?: string;
  /** Current branch name */
  currentBranch: string;
}

/**
 * Status of the PRD
 */
export interface PRDStatus {
  /** Total number of stories */
  total: number;
  /** Number of completed stories */
  completed: number;
  /** Number of incomplete stories */
  incomplete: number;
  /** Whether all stories are complete */
  allComplete: boolean;
  /** Highest priority incomplete story (if any) */
  nextStory?: UserStory;
}