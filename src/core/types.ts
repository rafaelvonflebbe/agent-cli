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
  /** Story IDs this story depends on (all must have passes: true before this story is eligible) */
  dependsOn?: string[];
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
 * AI tool selection — any registered tool name
 */
export type ToolType = string;

/**
 * Configuration for a registered tool
 */
export interface ToolConfig {
  /** Shell command to execute */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Prompt file name to pipe to stdin */
  promptFile: string;
}

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
  /** Total cost in USD (claude stream-json only) */
  totalCostUsd?: number;
  /** Duration in milliseconds (claude stream-json only) */
  durationMs?: number;
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
  /** Dry-run mode: simulate iterations without spawning tools */
  dryRun: boolean;
  /** Maximum number of stories to complete per run (undefined = unlimited) */
  maxStories?: number;
  /** Resume from a previous interrupted session */
  resume?: boolean;
  /** Docker sandbox configuration (undefined = no sandbox) */
  sandbox?: SandboxConfig;
  /** Permission mode for the AI tool (default: 'scoped') */
  permissionMode?: PermissionMode;
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
 * Session state persisted between interrupted runs
 */
export interface SessionState {
  /** Current iteration number when session was saved */
  currentIteration: number;
  /** Story IDs completed in this run */
  completedStoryIds: string[];
  /** Last story ID being worked on */
  lastStoryId: string | null;
  /** When the session was last updated */
  timestamp: string;
  /** Tool being used */
  tool: string;
  /** Branch name */
  branchName: string;
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

/**
 * Permission mode for the spawned AI tool
 * - 'scoped': uses --allowedTools with an allowlist (safer default)
 * - 'yolo': uses --dangerously-skip-permissions (full access)
 */
export type PermissionMode = 'scoped' | 'yolo';

/**
 * Docker sandbox configuration for running the agent tool in an isolated container
 */
export interface SandboxConfig {
  /** Docker image name */
  image: string;
  /** Memory limit (e.g., "512m") */
  memory?: string;
  /** CPU limit (e.g., "1.0") */
  cpu?: string;
}

/**
 * Global watch config stored at ~/.agent-cli/.watch.json
 */
export interface WatchConfig {
  /** Absolute paths to directories being monitored */
  directories: string[];
}

/**
 * Runtime status of a watched project
 */
export interface ProjectStatus {
  /** Directory path */
  directory: string;
  /** Project name from prd.json */
  project: string;
  /** Current branch */
  branch: string;
  /** Iteration progress (e.g., "3/10") */
  iteration: string;
  /** Story progress (e.g., "5/8") */
  stories: string;
  /** Running status: running, idle, done, stopped */
  status: 'running' | 'idle' | 'done' | 'stopped';
  /** Accumulated cost in USD */
  cost: number;
  /** Last activity timestamp */
  lastActivity: string;
}