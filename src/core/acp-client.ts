/**
 * ACP Client - wraps @agentclientprotocol/sdk ClientSideConnection
 *
 * Handles the full ACP session lifecycle: launch agent subprocess, initialize
 * protocol handshake, create session, send prompts as ContentBlocks, subscribe
 * to SessionUpdate notifications, parse structured content (text blocks, tool
 * calls with start/update/completed/failed states, diffs, terminal output),
 * detect session completion and idle states, handle errors with structured context.
 *
 * This is a standalone module — NOT wired into the main iterator loop yet.
 */

import { spawn, type ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { resolve, relative, isAbsolute } from 'path';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
  type SessionNotification,
  type SessionUpdate,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type LoadSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type RequestPermissionOutcome,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type McpServer,
  type SessionId,
  type ContentBlock,
  type StopReason,
  type AgentCapabilities,
  type Diff,
  type ToolCallContent,
  type ToolCallStatus,
  type ToolKind,
  type Cost,
} from '@agentclientprotocol/sdk';
import { info, debug, warn } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Event Bus — typed emitter for all ACP session events
// ---------------------------------------------------------------------------

/**
 * Session states tracked by the ACP client.
 */
export type ACPSessionState = 'working' | 'idle' | 'waiting_for_tool';

/**
 * A structured diff extracted from a tool call's content.
 */
export interface ACPDiffEvent {
  toolCallId: string;
  path: string;
  oldText: string | null;
  newText: string;
}

/**
 * Terminal output associated with a tool call.
 */
export interface ACPTerminalEvent {
  toolCallId: string;
  terminalId: string;
}

/**
 * A tool call lifecycle event with full context.
 */
export interface ACPToolCallEvent {
  toolCallId: string;
  title: string;
  status: ToolCallStatus;
  kind?: ToolKind;
  locations?: Array<{ path: string; line?: number | null }>;
  diffs: ACPDiffEvent[];
  terminals: ACPTerminalEvent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/**
 * Discriminated union of all events emitted by the ACP client.
 */
export type ACPEvent =
  | { type: 'state_change'; from: ACPSessionState; to: ACPSessionState }
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'tool_call'; toolCall: ACPToolCallEvent }
  | { type: 'tool_call_update'; toolCall: ACPToolCallEvent }
  | { type: 'plan'; entries: Array<{ content: string; priority: string; status: string }> }
  | { type: 'usage'; used: number; size: number; cost?: { amount: number; currency: string } }
  | { type: 'session_info'; title?: string; updatedAt?: string }
  | { type: 'prompt_complete'; stopReason: StopReason; usage?: ACPPromptResult['usage'] }
  | { type: 'error'; code: number; message: string; data?: unknown };

type ACPEventHandler = (event: ACPEvent) => void;

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Configuration for launching an ACP agent
 */
export interface ACPLaunchConfig {
  /** Command to spawn the agent (e.g. 'npx') */
  command: string;
  /** Arguments for the agent command (e.g. ['@anthropic-ai/claude-code', '--acp']) */
  args: string[];
  /** Working directory for the agent process */
  cwd: string;
  /** Environment variables for the agent process */
  env?: Record<string, string>;
}

/**
 * Options for creating a new ACP session
 */
export interface ACPSessionOptions {
  /** Working directory for the session */
  cwd: string;
  /** Optional MCP servers to attach */
  mcpServers?: McpServer[];
  /** Optional additional directories for filesystem scope */
  additionalDirectories?: string[];
}

/**
 * Collected results from a prompt turn
 */
export interface ACPPromptResult {
  /** The stop reason from the agent */
  stopReason: StopReason;
  /** All raw session updates received during the prompt turn */
  updates: SessionUpdate[];
  /** Agent text output accumulated from agent_message_chunk updates */
  textOutput: string;
  /** Agent thought output accumulated from agent_thought_chunk updates */
  thoughtOutput: string;
  /** Tool calls seen during the prompt turn, keyed by toolCallId */
  toolCalls: Map<string, ACPToolCallEvent>;
  /** Diffs extracted from tool call content */
  diffs: ACPDiffEvent[];
  /** Terminal references extracted from tool call content */
  terminals: ACPTerminalEvent[];
  /** Token usage if provided */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  };
  /** Cost information if provided */
  cost?: Cost;
}

/**
 * Structured ACP error with protocol error codes.
 */
export class ACPError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ACPError';
    this.code = code;
    this.data = data;
  }

  /** Standard JSON-RPC error codes */
  static isParseError(e: ACPError): boolean { return e.code === -32700; }
  static isInvalidRequest(e: ACPError): boolean { return e.code === -32600; }
  static isMethodNotFound(e: ACPError): boolean { return e.code === -32601; }
  static isInvalidParams(e: ACPError): boolean { return e.code === -32602; }
  static isInternalError(e: ACPError): boolean { return e.code === -32603; }
  static isAuthRequired(e: ACPError): boolean { return e.code === -32002; }

  /** Human-readable description of the error code */
  describeCode(): string {
    switch (this.code) {
      case -32700: return 'Parse error: invalid JSON received';
      case -32600: return 'Invalid request: the JSON sent is not a valid Request object';
      case -32601: return 'Method not found: the method does not exist or is not available';
      case -32602: return 'Invalid params: invalid method parameter(s)';
      case -32603: return 'Internal error: internal JSON-RPC error';
      case -32800: return 'Request cancelled: the request was cancelled by the client';
      case -32000: return 'Server error: generic server-defined error';
      case -32002: return 'Auth required: authentication is required';
      case -32042: return 'Session error: session-related failure';
      default: return `Unknown error code: ${this.code}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Filesystem boundary validation
// ---------------------------------------------------------------------------

/**
 * Error thrown when an agent attempts a filesystem operation outside its
 * allowed roots. Uses ACP error code -32000 (server error) since there is
 * no dedicated filesystem-access-denied code in the spec.
 */
export class ACPFileSystemError extends ACPError {
  /** The path that was denied */
  readonly path: string;
  /** The allowed roots */
  readonly allowedRoots: string[];

  constructor(path: string, allowedRoots: string[]) {
    super(
      -32000,
      `Filesystem access denied: path '${path}' is outside allowed roots [${allowedRoots.join(', ')}]`,
    );
    this.name = 'ACPFileSystemError';
    this.path = path;
    this.allowedRoots = allowedRoots;
  }
}

/**
 * Check whether a resolved absolute path falls within any of the allowed roots.
 * Both the path and roots are normalized before comparison.
 */
function isPathWithin(path: string, roots: string[]): boolean {
  for (const root of roots) {
    // relative(from, to) returns a path that starts with '..' if `to` is
    // outside `from`. An empty string means the paths are identical.
    const rel = relative(root, path);
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal helper: extract diffs and terminals from ToolCallContent
// ---------------------------------------------------------------------------

function extractToolCallContent(
  content: ToolCallContent[] | undefined | null,
  toolCallId: string,
): { diffs: ACPDiffEvent[]; terminals: ACPTerminalEvent[] } {
  const diffs: ACPDiffEvent[] = [];
  const terminals: ACPTerminalEvent[] = [];

  if (!content) return { diffs, terminals };

  for (const item of content) {
    if ('type' in item) {
      if (item.type === 'diff') {
        const d = item as Diff & { type: 'diff' };
        diffs.push({
          toolCallId,
          path: d.path,
          oldText: d.oldText ?? null,
          newText: d.newText,
        });
      } else if (item.type === 'terminal') {
        const t = item as { terminalId: string; type: 'terminal' };
        terminals.push({
          toolCallId,
          terminalId: t.terminalId,
        });
      }
    }
  }

  return { diffs, terminals };
}

// ---------------------------------------------------------------------------
// ACPClient class
// ---------------------------------------------------------------------------

/**
 * ACP Client class — wraps the ACP SDK ClientSideConnection to manage
 * an agent subprocess with structured protocol-based communication.
 *
 * Provides:
 * - Full session lifecycle: launch → initialize → create session → prompt → close
 * - Structured update handling for all ACP content types
 * - Session state tracking (working / idle / waiting_for_tool)
 * - Typed event bus for UI and journaling integration
 * - Structured error handling with ACP error codes
 * - Session resumption via LoadSession
 */
export class ACPClient {
  private connection: ClientSideConnection | null = null;
  private process: ChildProcess | null = null;
  private sessionId: SessionId | null = null;
  private agentCapabilities: AgentCapabilities | null = null;
  private updateBuffer: SessionUpdate[] = [];

  /** Tracked session state */
  private sessionState: ACPSessionState = 'idle';

  /** Event listeners */
  private listeners: Set<ACPEventHandler> = new Set();

  /** Permission resolver */
  private _permissionResolver?: (request: RequestPermissionRequest) => Promise<RequestPermissionOutcome>;

  /**
   * Filesystem boundary enforcement.
   * `allowedRoots` is populated from session cwd + additionalDirectories.
   * All fs operations (readTextFile, writeTextFile) are validated against
   * these roots — attempts to access paths outside them are rejected.
   */
  private allowedRoots: string[] = [];
  private sessionCwd: string | null = null;

  // -----------------------------------------------------------------------
  // Event bus
  // -----------------------------------------------------------------------

  /**
   * Subscribe to ACP events.
   * Returns an unsubscribe function.
   */
  on(handler: ACPEventHandler): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }

  /**
   * Subscribe to ACP events for one emission only.
   */
  once(handler: ACPEventHandler): () => void {
    const wrapper: ACPEventHandler = (event) => {
      this.listeners.delete(wrapper);
      handler(event);
    };
    this.listeners.add(wrapper);
    return () => { this.listeners.delete(wrapper); };
  }

  /**
   * Remove all event listeners.
   */
  removeAllListeners(): void {
    this.listeners.clear();
  }

  /** Emit an event to all registered listeners. */
  private emit(event: ACPEvent): void {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch (err) {
        warn(`ACP: Error in event handler: ${err}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Session state
  // -----------------------------------------------------------------------

  /**
   * Get the current session state.
   */
  getState(): ACPSessionState {
    return this.sessionState;
  }

  /**
   * Transition to a new session state, emitting a state_change event.
   */
  private transitionTo(newState: ACPSessionState): void {
    if (this.sessionState === newState) return;
    const oldState = this.sessionState;
    this.sessionState = newState;
    debug(`ACP: State transition ${oldState} → ${newState}`);
    this.emit({ type: 'state_change', from: oldState, to: newState });
  }

  // -----------------------------------------------------------------------
  // Launch & Initialize
  // -----------------------------------------------------------------------

  /**
   * Launch an agent subprocess and perform the ACP handshake
   * (Initialize + optional NewSession).
   */
  async launch(
    config: ACPLaunchConfig,
    sessionOptions?: ACPSessionOptions,
  ): Promise<{ initialized: InitializeResponse; sessionId?: SessionId }> {
    if (this.connection) {
      throw new ACPError(-32600, 'ACPClient already has an active connection. Call close() first.');
    }

    info(`ACP: Launching agent: ${config.command} ${config.args.join(' ')}`);
    this.process = spawn(config.command, config.args, {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, ...config.env },
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new ACPError(-32000, 'Failed to create agent subprocess with piped stdio');
    }

    // Convert Node.js streams to Web Streams API for the ACP SDK
    const webStdin = Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>;
    const webStdout = Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(webStdin, webStdout);

    // Create the ClientSideConnection with our Client handler
    const clientHandler = (_agent: Agent): Client => this.createClientHandler();
    this.connection = new ClientSideConnection(clientHandler, stream);

    // Log stderr from the agent subprocess
    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        debug(`ACP agent stderr: ${msg}`);
      }
    });

    // Handle process exit
    this.process.on('close', (code, signal) => {
      debug(`ACP: Agent process exited with code=${code}, signal=${signal}`);
      this.transitionTo('idle');
    });

    // Step 1: Initialize — protocol handshake
    try {
      const initResponse = await this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: 'agent-cli',
          version: '1.0.0',
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
      });

      this.agentCapabilities = initResponse.agentCapabilities ?? null;
      info(`ACP: Initialized — agent=${initResponse.agentInfo?.name ?? 'unknown'} v${initResponse.agentInfo?.version ?? '?'}, protocol=${initResponse.protocolVersion}`);

      // Handle authentication if required
      if (initResponse.authMethods && initResponse.authMethods.length > 0) {
        const agentAuth = initResponse.authMethods[0];
        if (agentAuth) {
          info(`ACP: Authenticating via ${agentAuth.name}`);
          await this.connection.authenticate({ methodId: agentAuth.id });
        }
      }

      // Step 2: Optionally create a new session
      let sessionId: SessionId | undefined;
      if (sessionOptions) {
        sessionId = await this.createSession(sessionOptions);
      }

      return { initialized: initResponse, sessionId };
    } catch (err: unknown) {
      throw wrapACPError(err);
    }
  }

  // -----------------------------------------------------------------------
  // Session management
  // -----------------------------------------------------------------------

  /**
   * Create a new ACP session within the existing connection.
   *
   * Records the session's filesystem scope (cwd + additionalDirectories)
   * as allowed roots for filesystem boundary validation.
   */
  async createSession(options: ACPSessionOptions): Promise<SessionId> {
    if (!this.connection) {
      throw new ACPError(-32600, 'ACPClient not initialized. Call launch() first.');
    }

    try {
      const response: NewSessionResponse = await this.connection.newSession({
        cwd: options.cwd,
        mcpServers: options.mcpServers ?? [],
        additionalDirectories: options.additionalDirectories,
      });

      this.sessionId = response.sessionId;
      this.setAllowedRoots(options.cwd, options.additionalDirectories);
      this.transitionTo('idle');
      info(`ACP: Session created — id=${response.sessionId}`);

      if (response.modes) {
        debug(`ACP: Available modes: ${response.modes.availableModes.map(m => m.name).join(', ')} (current: ${response.modes.currentModeId})`);
      }

      return response.sessionId;
    } catch (err: unknown) {
      throw wrapACPError(err);
    }
  }

  /**
   * Load an existing ACP session for resumption.
   * Requires the agent to advertise `loadSession` capability.
   *
   * Records the session's filesystem scope (cwd + additionalDirectories)
   * as allowed roots for filesystem boundary validation.
   *
   * @param sessionId - The session ID to load
   * @param options - Session options (cwd, MCP servers, etc.)
   */
  async loadSession(
    sessionId: SessionId,
    options: ACPSessionOptions,
  ): Promise<LoadSessionResponse> {
    if (!this.connection) {
      throw new ACPError(-32600, 'ACPClient not initialized. Call launch() first.');
    }

    if (!this.agentCapabilities?.loadSession) {
      throw new ACPError(-32601, 'Agent does not support session loading (loadSession capability not advertised).');
    }

    try {
      const response = await this.connection.loadSession({
        sessionId,
        cwd: options.cwd,
        mcpServers: options.mcpServers ?? [],
        additionalDirectories: options.additionalDirectories,
      });

      this.sessionId = sessionId;
      this.setAllowedRoots(options.cwd, options.additionalDirectories);
      this.transitionTo('idle');
      info(`ACP: Session loaded — id=${sessionId}`);

      return response;
    } catch (err: unknown) {
      throw wrapACPError(err);
    }
  }

  // -----------------------------------------------------------------------
  // Prompt handling
  // -----------------------------------------------------------------------

  /**
   * Send a prompt to the agent and collect structured updates.
   *
   * During execution, the session transitions to 'working'.
   * When tool calls are in progress, transitions to 'waiting_for_tool'.
   * On completion, transitions back to 'idle'.
   */
  async sendPrompt(
    sessionId: SessionId | undefined,
    prompt: string | ContentBlock[],
  ): Promise<ACPPromptResult> {
    if (!this.connection) {
      throw new ACPError(-32600, 'ACPClient not initialized. Call launch() first.');
    }

    const sid = sessionId ?? this.sessionId;
    if (!sid) {
      throw new ACPError(-32602, 'No session ID provided and no active session.');
    }

    // Build prompt content blocks (TextBlock style)
    const contentBlocks: ContentBlock[] = typeof prompt === 'string'
      ? [{ type: 'text', text: prompt }]
      : prompt;

    // Reset update buffer
    this.updateBuffer = [];

    const result: ACPPromptResult = {
      stopReason: 'end_turn',
      updates: [],
      textOutput: '',
      thoughtOutput: '',
      toolCalls: new Map(),
      diffs: [],
      terminals: [],
    };

    this.transitionTo('working');

    try {
      // Send the prompt
      info(`ACP: Sending prompt (${contentBlocks.length} block(s)) to session ${sid}`);
      const response: PromptResponse = await this.connection.prompt({
        sessionId: sid,
        prompt: contentBlocks,
      });

      result.stopReason = response.stopReason;

      if (response.usage) {
        result.usage = {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          thoughtTokens: response.usage.thoughtTokens ?? undefined,
          cachedReadTokens: response.usage.cachedReadTokens ?? undefined,
          cachedWriteTokens: response.usage.cachedWriteTokens ?? undefined,
        };
      }

      // Process collected updates
      for (const update of this.updateBuffer) {
        result.updates.push(update);
        this.processUpdate(update, result);
      }

      info(`ACP: Prompt complete — stopReason=${result.stopReason}, updates=${result.updates.length}, toolCalls=${result.toolCalls.size}, diffs=${result.diffs.length}`);

      // Emit prompt_complete event
      this.emit({
        type: 'prompt_complete',
        stopReason: result.stopReason,
        usage: result.usage,
      });

      this.transitionTo('idle');
      return result;
    } catch (err: unknown) {
      this.transitionTo('idle');
      const acpErr = wrapACPError(err);
      this.emit({ type: 'error', code: acpErr.code, message: acpErr.message, data: acpErr.data });
      throw acpErr;
    }
  }

  /**
   * Cancel an ongoing prompt turn.
   */
  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) {
      return;
    }

    info(`ACP: Cancelling session ${this.sessionId}`);
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch (err: unknown) {
      throw wrapACPError(err);
    }
  }

  // -----------------------------------------------------------------------
  // Close / cleanup
  // -----------------------------------------------------------------------

  /**
   * Gracefully shut down the session and process.
   */
  async close(): Promise<void> {
    info('ACP: Closing connection');

    // Try to close the session if the agent supports it
    if (this.connection && this.sessionId) {
      try {
        await this.connection.unstable_closeSession({ sessionId: this.sessionId });
      } catch {
        // Session close may not be supported — that's fine
      }
    }

    // Kill the subprocess
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      // Give it a moment to exit gracefully
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }

    this.connection = null;
    this.process = null;
    this.sessionId = null;
    this.agentCapabilities = null;
    this.updateBuffer = [];
    this.allowedRoots = [];
    this.sessionCwd = null;
    this.transitionTo('idle');
    this.removeAllListeners();
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /**
   * Get the current session ID.
   */
  getSessionId(): SessionId | null {
    return this.sessionId;
  }

  /**
   * Get the agent capabilities from initialization.
   */
  getAgentCapabilities(): AgentCapabilities | null {
    return this.agentCapabilities;
  }

  /**
   * Check if the client is connected.
   */
  isConnected(): boolean {
    return this.connection !== null && this.process !== null && !this.process.killed;
  }

  /**
   * Set a custom permission resolver for tool call approvals.
   */
  setPermissionResolver(resolver: (request: RequestPermissionRequest) => Promise<RequestPermissionOutcome>): void {
    this._permissionResolver = resolver;
  }

  // -----------------------------------------------------------------------
  // Filesystem boundary accessors
  // -----------------------------------------------------------------------

  /**
   * Get the list of allowed filesystem roots for the current session.
   * Returns an empty array if no session has been created.
   */
  getAllowedRoots(): string[] {
    return [...this.allowedRoots];
  }

  /**
   * Resolve a path against the session cwd and validate it is within
   * the allowed roots. Returns the resolved absolute path.
   *
   * @throws ACPFileSystemError if the path is outside allowed roots
   */
  resolveAndValidatePath(filePath: string): string {
    // Resolve relative paths against the session cwd
    const resolved = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(this.sessionCwd ?? process.cwd(), filePath);

    if (this.allowedRoots.length > 0 && !isPathWithin(resolved, this.allowedRoots)) {
      throw new ACPFileSystemError(resolved, this.allowedRoots);
    }

    return resolved;
  }

  // -----------------------------------------------------------------------
  // Private: Allowed roots management
  // -----------------------------------------------------------------------

  /**
   * Set the allowed filesystem roots from session options.
   * The cwd is always the primary root; additionalDirectories extend the scope.
   */
  private setAllowedRoots(cwd: string, additionalDirectories?: string[]): void {
    this.sessionCwd = resolve(cwd);
    this.allowedRoots = [this.sessionCwd];

    if (additionalDirectories?.length) {
      for (const dir of additionalDirectories) {
        const resolved = resolve(dir);
        if (!this.allowedRoots.includes(resolved)) {
          this.allowedRoots.push(resolved);
        }
      }
    }

    info(`ACP: Filesystem boundaries active — allowed roots: ${this.allowedRoots.join(', ')}`);
  }

  // -----------------------------------------------------------------------
  // Private: Client handler (receives agent requests)
  // -----------------------------------------------------------------------

  private createClientHandler(): Client {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        // Buffer updates for the current prompt turn
        this.updateBuffer.push(params.update);
      },

      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const toolCall = params.toolCall;
        info(`ACP: Permission requested for tool: ${toolCall.title} (id=${toolCall.toolCallId})`);

        // Transition to waiting_for_tool while permission is pending
        this.transitionTo('waiting_for_tool');

        // If a custom resolver is set, use it
        if (this._permissionResolver) {
          const outcome = await this._permissionResolver(params);
          return { outcome };
        }

        // Default: auto-approve with "allow_always" if available
        const allowAlways = params.options.find(o => o.kind === 'allow_always');
        const allowOnce = params.options.find(o => o.kind === 'allow_once');
        const selectedOption = allowAlways ?? allowOnce ?? params.options[0];

        if (selectedOption) {
          return {
            outcome: {
              outcome: 'selected',
              optionId: selectedOption.optionId,
            },
          };
        }

        return { outcome: { outcome: 'cancelled' } };
      },

      readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
        const validatedPath = this.resolveAndValidatePath(params.path);
        debug(`ACP fs: readTextFile ${validatedPath}`);
        const { readFile } = await import('fs/promises');
        const content = await readFile(validatedPath, 'utf-8');
        return { content };
      },

      writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
        const validatedPath = this.resolveAndValidatePath(params.path);
        debug(`ACP fs: writeTextFile ${validatedPath}`);
        const { writeFile } = await import('fs/promises');
        await writeFile(validatedPath, params.content, 'utf-8');
        return {};
      },
    };
  }

  // -----------------------------------------------------------------------
  // Private: Update processing
  // -----------------------------------------------------------------------

  /**
   * Process a single SessionUpdate and accumulate into the result.
   * Emits typed events for each update kind.
   */
  private processUpdate(update: SessionUpdate, result: ACPPromptResult): void {
    switch (update.sessionUpdate) {
      // --- Agent text output ---
      case 'agent_message_chunk': {
        const content = update.content;
        if (content.type === 'text') {
          result.textOutput += content.text;
          process.stdout.write(content.text);
          this.emit({ type: 'text_delta', text: content.text });
        }
        break;
      }

      // --- Agent thought/reasoning output ---
      case 'agent_thought_chunk': {
        const content = update.content;
        if (content.type === 'text') {
          result.thoughtOutput += content.text;
          this.emit({ type: 'thought_delta', text: content.text });
        }
        break;
      }

      // --- User message echo ---
      case 'user_message_chunk': {
        // Echo of user input, not usually needed for processing
        debug('ACP: User message chunk echoed');
        break;
      }

      // --- Tool call started ---
      case 'tool_call': {
        this.transitionTo('waiting_for_tool');
        const { diffs, terminals } = extractToolCallContent(update.content, update.toolCallId);
        const toolCallEvent: ACPToolCallEvent = {
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status ?? 'pending',
          kind: update.kind,
          locations: update.locations?.map(l => ({ path: l.path, line: l.line })),
          diffs,
          terminals,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
        };

        result.toolCalls.set(update.toolCallId, toolCallEvent);
        result.diffs.push(...diffs);
        result.terminals.push(...terminals);

        this.emit({ type: 'tool_call', toolCall: toolCallEvent });
        info(`ACP: Tool call — ${update.title} (${update.toolCallId}) kind=${update.kind ?? '?'} status=${update.status ?? 'pending'}`);
        break;
      }

      // --- Tool call update (progress/result) ---
      case 'tool_call_update': {
        const existing = result.toolCalls.get(update.toolCallId);
        const { diffs: newDiffs, terminals: newTerminals } = extractToolCallContent(update.content, update.toolCallId);

        if (existing) {
          // Merge update into existing tool call
          if (update.title) existing.title = update.title;
          if (update.status) existing.status = update.status;
          if (update.kind) existing.kind = update.kind;
          if (update.rawInput !== undefined) existing.rawInput = update.rawInput;
          if (update.rawOutput !== undefined) existing.rawOutput = update.rawOutput;
          if (update.locations) {
            existing.locations = update.locations.map(l => ({ path: l.path, line: l.line }));
          }
          existing.diffs.push(...newDiffs);
          existing.terminals.push(...newTerminals);
        } else {
          // Update arrived before the initial tool_call — create a partial entry
          const toolCallEvent: ACPToolCallEvent = {
            toolCallId: update.toolCallId,
            title: update.title ?? 'Unknown tool',
            status: update.status ?? 'pending',
            kind: update.kind ?? undefined,
            locations: update.locations?.map(l => ({ path: l.path, line: l.line })),
            diffs: newDiffs,
            terminals: newTerminals,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
          };
          result.toolCalls.set(update.toolCallId, toolCallEvent);
        }

        result.diffs.push(...newDiffs);
        result.terminals.push(...newTerminals);

        // Track state based on tool status
        if (update.status === 'in_progress') {
          this.transitionTo('waiting_for_tool');
        } else if (update.status === 'completed' || update.status === 'failed') {
          // Check if all active tool calls are done — if so, back to working
          let allDone = true;
          for (const tc of result.toolCalls.values()) {
            if (tc.status === 'pending' || tc.status === 'in_progress') {
              allDone = false;
              break;
            }
          }
          if (allDone) {
            this.transitionTo('working');
          }
        }

        const current = result.toolCalls.get(update.toolCallId);
        if (current) {
          this.emit({ type: 'tool_call_update', toolCall: current });
        }

        debug(`ACP: Tool call update — ${update.toolCallId} status=${update.status ?? '?'}`);
        break;
      }

      // --- Execution plan ---
      case 'plan': {
        const entries = update.entries.map(e => ({
          content: e.content,
          priority: e.priority,
          status: e.status,
        }));
        this.emit({ type: 'plan', entries });
        debug(`ACP: Plan update — ${update.entries.length} entries`);
        break;
      }

      // --- Usage / context window ---
      case 'usage_update': {
        const costInfo = update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : undefined;
        this.emit({ type: 'usage', used: update.used, size: update.size, cost: costInfo });

        if (update.cost) {
          result.cost = update.cost;
        }

        debug(`ACP: Usage update — ${update.used}/${update.size} tokens${update.cost ? ` cost=${update.cost.amount} ${update.cost.currency}` : ''}`);
        break;
      }

      // --- Session info ---
      case 'session_info_update': {
        this.emit({
          type: 'session_info',
          title: update.title ?? undefined,
          updatedAt: update.updatedAt ?? undefined,
        });
        debug(`ACP: Session info update — title=${update.title ?? 'n/a'}`);
        break;
      }

      // --- Mode / config changes ---
      case 'current_mode_update': {
        debug(`ACP: Mode changed to ${update.currentModeId}`);
        break;
      }

      case 'config_option_update': {
        debug(`ACP: Config option update`);
        break;
      }

      case 'available_commands_update': {
        debug(`ACP: Available commands update`);
        break;
      }

      default: {
        debug(`ACP: Unhandled update type=${(update as { sessionUpdate: string }).sessionUpdate}`);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Error wrapping utility
// ---------------------------------------------------------------------------

/**
 * Wrap an unknown error into an ACPError with structured error codes.
 * Handles JSON-RPC error responses from the SDK as well as Node.js errors.
 */
function wrapACPError(err: unknown): ACPError {
  if (err instanceof ACPError) {
    return err;
  }

  // The ACP SDK throws errors that may have a JSON-RPC error structure
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;

    // JSON-RPC style error from the protocol
    if ('code' in e && 'message' in e && typeof e.code === 'number') {
      return new ACPError(e.code, String(e.message), e.data);
    }

    // SDK may throw a generic Error with cause
    if (err instanceof Error) {
      // Check for nested JSON-RPC error in the cause chain
      const cause = (err as { cause?: unknown }).cause;
      if (cause && typeof cause === 'object') {
        const c = cause as Record<string, unknown>;
        if ('code' in c && 'message' in c && typeof c.code === 'number') {
          return new ACPError(c.code as number, String(c.message), c.data);
        }
      }

      // Map common Node.js errors to ACP-like codes
      if ('code' in e) {
        const nodeCode = e.code;
        if (nodeCode === 'ENOENT') {
          return new ACPError(-32000, `Agent process not found: ${err.message}`);
        }
        if (nodeCode === 'EACCES') {
          return new ACPError(-32000, `Permission denied: ${err.message}`);
        }
      }

      return new ACPError(-32603, err.message);
    }
  }

  if (err instanceof Error) {
    return new ACPError(-32603, err.message);
  }

  return new ACPError(-32603, String(err));
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an ACPClient instance.
 */
export function createACPClient(): ACPClient {
  return new ACPClient();
}
