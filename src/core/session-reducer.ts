/**
 * Session state reducer — centralizes all session state transitions.
 *
 * Pure reducer function + SessionStore wrapper that persists to .session.json
 * after every dispatch (single write point).
 */

import type { SessionState, TokenUsage, TokenSession } from './types.js';
import { createSessionManager, type SessionManager } from './session.js';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type SessionAction =
  | { type: 'STORY_COMPLETED'; storyId: string }
  | { type: 'ITERATION_FINISHED'; iteration: number; costUsd?: number; durationMs?: number; acpSessionId?: string; tokenUsage?: TokenUsage }
  | { type: 'SESSION_INTERRUPTED'; lastStoryId: string | null; acpSessionId?: string }
  | { type: 'BRANCH_CHANGED'; newBranch: string }
  | { type: 'STOPWHEN_TRIGGERED'; reason: string }
  | { type: 'SESSION_RESUMED'; completedStoryIds: string[]; iteration: number; acpSessionId?: string };

// ---------------------------------------------------------------------------
// Normalize — fills defaults for new fields when loading old .session.json
// ---------------------------------------------------------------------------

export function normalizeSessionState(raw: Partial<SessionState>): SessionState {
  return {
    currentIteration: raw.currentIteration ?? 0,
    completedStoryIds: raw.completedStoryIds ?? [],
    lastStoryId: raw.lastStoryId ?? null,
    timestamp: raw.timestamp ?? new Date().toISOString(),
    tool: raw.tool ?? 'claude',
    branchName: raw.branchName ?? '',
    acpSessionId: raw.acpSessionId,
    isResumed: raw.isResumed,
    storiesCompletedThisRun: raw.storiesCompletedThisRun ?? 0,
    totalCostUsd: raw.totalCostUsd ?? 0,
    totalDurationMs: raw.totalDurationMs ?? 0,
    tokens: raw.tokens ?? { totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0 },
    sessionStartTime: raw.sessionStartTime ?? Date.now(),
    stopWhenTriggered: raw.stopWhenTriggered ?? false,
    stopWhenReason: raw.stopWhenReason,
  };
}

// ---------------------------------------------------------------------------
// Reducer — pure function, no side effects
// ---------------------------------------------------------------------------

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  const timestamp = new Date().toISOString();

  switch (action.type) {
    case 'STORY_COMPLETED':
      return {
        ...state,
        completedStoryIds: [...state.completedStoryIds, action.storyId],
        lastStoryId: action.storyId,
        storiesCompletedThisRun: (state.storiesCompletedThisRun ?? 0) + 1,
        timestamp,
      };

    case 'ITERATION_FINISHED': {
      const prevTokens: TokenSession = state.tokens ?? { totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0 };
      const usage = action.tokenUsage;
      const nextTokens: TokenSession = usage
        ? {
            totalInputTokens: prevTokens.totalInputTokens + usage.inputTokens,
            totalOutputTokens: prevTokens.totalOutputTokens + usage.outputTokens,
            totalCacheCreationTokens: prevTokens.totalCacheCreationTokens + usage.cacheCreationInputTokens,
            totalCacheReadTokens: prevTokens.totalCacheReadTokens + usage.cacheReadInputTokens,
          }
        : prevTokens;
      return {
        ...state,
        currentIteration: action.iteration,
        totalCostUsd: (state.totalCostUsd ?? 0) + (action.costUsd ?? 0),
        totalDurationMs: (state.totalDurationMs ?? 0) + (action.durationMs ?? 0),
        acpSessionId: action.acpSessionId ?? state.acpSessionId,
        tokens: nextTokens,
        timestamp,
      };
    }

    case 'SESSION_INTERRUPTED':
      return {
        ...state,
        currentIteration: state.currentIteration,
        lastStoryId: action.lastStoryId,
        acpSessionId: action.acpSessionId ?? state.acpSessionId,
        isResumed: false,
        timestamp,
      };

    case 'BRANCH_CHANGED':
      return {
        ...state,
        branchName: action.newBranch,
        timestamp,
      };

    case 'STOPWHEN_TRIGGERED':
      return {
        ...state,
        stopWhenTriggered: true,
        stopWhenReason: action.reason,
        timestamp,
      };

    case 'SESSION_RESUMED':
      return {
        ...state,
        completedStoryIds: action.completedStoryIds,
        currentIteration: action.iteration,
        acpSessionId: action.acpSessionId ?? state.acpSessionId,
        isResumed: true,
        timestamp,
      };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// SessionStore — wraps reducer + SessionManager, single write point
// ---------------------------------------------------------------------------

export class SessionStore {
  private state: SessionState;
  private readonly sessionManager: SessionManager;

  constructor(sessionManager: SessionManager, initialState: SessionState) {
    this.sessionManager = sessionManager;
    this.state = initialState;
  }

  /**
   * Create a fresh session store (new run).
   */
  static async create(directory: string, tool: string, branchName: string): Promise<SessionStore> {
    const sm = createSessionManager(directory);
    const initialState: SessionState = normalizeSessionState({
      currentIteration: 0,
      completedStoryIds: [],
      lastStoryId: null,
      timestamp: new Date().toISOString(),
      tool,
      branchName,
      storiesCompletedThisRun: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      tokens: { totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0 },
      sessionStartTime: Date.now(),
      stopWhenTriggered: false,
      stopWhenReason: undefined,
    });
    await sm.create(tool, branchName);
    // Overwrite with full state (sm.create writes a minimal state)
    await sm.update(initialState);
    return new SessionStore(sm, initialState);
  }

  /**
   * Resume from an existing .session.json file.
   * Returns null if no session file exists.
   */
  static async resume(directory: string): Promise<SessionStore | null> {
    const sm = createSessionManager(directory);
    if (!(await sm.exists())) return null;

    const raw = await sm.load();
    const state = normalizeSessionState(raw);
    return new SessionStore(sm, state);
  }

  /**
   * Dispatch an action through the reducer and persist the result.
   * Single write point — all state mutations go through here.
   */
  async dispatch(action: SessionAction): Promise<SessionState> {
    this.state = sessionReducer(this.state, action);
    await this.sessionManager.update(this.state);
    return this.state;
  }

  /**
   * Get the current state (read-only snapshot).
   */
  getState(): SessionState {
    return this.state;
  }

  /**
   * Delete the session file (clean exit).
   */
  async delete(): Promise<void> {
    await this.sessionManager.delete();
  }

  /**
   * Check if the underlying session file exists.
   */
  async exists(): Promise<boolean> {
    return this.sessionManager.exists();
  }

  /**
   * Get the session file path.
   */
  getPath(): string {
    return this.sessionManager.getPath();
  }
}

/**
 * Create a session store for a new run.
 */
export function createSessionStore(directory: string, tool: string, branchName: string): Promise<SessionStore> {
  return SessionStore.create(directory, tool, branchName);
}

/**
 * Resume a session store from an existing .session.json.
 */
export function resumeSessionStore(directory: string): Promise<SessionStore | null> {
  return SessionStore.resume(directory);
}
