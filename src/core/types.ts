/**
 * Core TypeScript interfaces for the Agent CLI
 */

/**
 * Declarative conditions for when the agent loop should stop.
 * Conditions use OR logic — any condition being met triggers a stop.
 */
export interface StopWhenCondition {
  /** Stop when these specific story IDs are completed */
  stories?: string[];
  /** Stop when accumulated cost exceeds this threshold in USD (ACP only) */
  maxCostUsd?: number;
  /** Stop when total session time exceeds this limit in minutes */
  maxDurationMinutes?: number;
}

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
  /**
   * Absolute or relative path to the project directory where the AI tool
   * actually works (cwd for the spawned process).
   * If omitted, defaults to the directory containing prd.json.
   */
  projectDirectory?: string;
  /** MCP servers to attach to ACP sessions for this project */
  mcpServers?: McpServerConfig[];
  /** Custom conditions for when the agent loop should stop (OR logic) */
  stopWhen?: StopWhenCondition;
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
  /**
   * Project directory where the AI tool works (cwd for the spawned process).
   * If omitted, defaults to `directory`.
   */
  projectDirectory?: string;
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
  /** Force ACP (Agent Client Protocol) mode instead of legacy spawn */
  acp?: boolean;
  /** Specific story IDs to run (comma-separated). Skips priority ordering. */
  storyIds?: string[];
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
  /** ACP session ID for resumption (set when using ACP providers) */
  acpSessionId?: string;
  /** Whether this session was resumed from a previous interrupted run */
  isResumed?: boolean;
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
 * A configured MCP server in simplified agent-cli format.
 * Uses Record<string, string> for env (more ergonomic than the ACP SDK's EnvVariable[]).
 * Converted to the ACP SDK's McpServer format at session creation time.
 */
export interface McpServerConfig {
  /** Human-readable name for this MCP server */
  name: string;
  /** Command to launch the MCP server (e.g. "npx") */
  command: string;
  /** Arguments for the MCP server command */
  args: string[];
  /** Environment variables to set when launching the MCP server */
  env?: Record<string, string>;
}

/**
 * Capabilities an ACP provider supports
 */
export interface ACPProviderCapabilities {
  /** Whether the provider supports filesystem operations */
  fs: boolean;
  /** Whether the provider supports terminal/command execution */
  terminal: boolean;
}

/**
 * A registered ACP provider (agent adapter)
 */
export interface ACPProvider {
  /** Unique provider name (e.g. "claude", "codex") — maps to --tool flag */
  name: string;
  /** Command to spawn the ACP adapter (e.g. "npx") */
  command: string;
  /** Arguments for the adapter command (e.g. ["@agentclientprotocol/claude-agent-acp"]) */
  args: string[];
  /** Capabilities this provider supports */
  capabilities: ACPProviderCapabilities;
  /** Default environment variables for the subprocess */
  env?: Record<string, string>;
  /** Optional install hint if the adapter is not found (e.g. "npm install -g @agentclientprotocol/claude-agent-acp") */
  installHint?: string;
  /** Default MCP servers to attach to every session created with this provider */
  defaultMcpServers?: McpServerConfig[];
}

/**
 * Custom providers config stored at ~/.agent-cli/providers.json
 */
export interface ProvidersConfig {
  /** User-defined ACP providers */
  providers: ACPProvider[];
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
  /** Running status: running, idle, done, stopped, resumed */
  status: 'running' | 'idle' | 'done' | 'stopped' | 'resumed';
  /** Accumulated cost in USD */
  cost: number;
  /** Last activity timestamp */
  lastActivity: string;
  /** Whether this project's session was resumed from a previous interrupted run */
  isResumed?: boolean;
}