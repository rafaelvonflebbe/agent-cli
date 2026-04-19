/**
 * Context window tracking and reporting.
 *
 * Maps known model context window sizes, computes utilization percentage,
 * and formats human-readable reports for CLI output and log files.
 */

import type { TokenSession, TokenUsage } from './types.js';

/**
 * Known context window sizes in tokens, keyed by model family prefix.
 * Keys are matched as prefixes against the model identifier.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-sonnet-4': 200_000,
  'claude-opus-4': 200_000,
  'claude-haiku-4': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
};

/** Default context window when model is unknown */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Get the context window size for a given model identifier.
 * Falls back to the default (200k) for unknown models.
 */
export function getContextWindowSize(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const lower = model.toLowerCase();
  for (const [prefix, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (lower.startsWith(prefix)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Format a token count as a compact human-readable string.
 * E.g., 45200 → "45.2k"
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

/**
 * Compute cache hit rate as a percentage.
 * Cache hit rate = cacheReadTokens / (cacheReadTokens + cacheCreationTokens + inputTokens)
 * Returns 0 if no token data available.
 */
export function cacheHitRate(tokens: TokenSession | undefined): number {
  if (!tokens) return 0;
  const { totalCacheReadTokens, totalCacheCreationTokens, totalInputTokens } = tokens;
  const total = totalCacheReadTokens + totalCacheCreationTokens + totalInputTokens;
  if (total === 0) return 0;
  return (totalCacheReadTokens / total) * 100;
}

/**
 * Compute context window utilization percentage.
 * Uses total input tokens as the context usage indicator.
 */
export function contextUtilization(tokens: TokenSession | undefined, contextWindowSize: number): number {
  if (!tokens) return 0;
  const used = tokens.totalInputTokens + tokens.totalCacheReadTokens + tokens.totalCacheCreationTokens;
  if (contextWindowSize === 0) return 0;
  return (used / contextWindowSize) * 100;
}

/**
 * Check whether a token session or usage object has any non-zero values.
 */
function hasTokenData(tokens: TokenUsage | TokenSession | undefined): boolean {
  if (!tokens) return false;
  if ('totalInputTokens' in tokens) {
    return (tokens as TokenSession).totalInputTokens > 0
      || (tokens as TokenSession).totalOutputTokens > 0
      || (tokens as TokenSession).totalCacheCreationTokens > 0
      || (tokens as TokenSession).totalCacheReadTokens > 0;
  }
  return (tokens as TokenUsage).inputTokens > 0
    || (tokens as TokenUsage).outputTokens > 0
    || (tokens as TokenUsage).cacheCreationInputTokens > 0
    || (tokens as TokenUsage).cacheReadInputTokens > 0;
}

/**
 * Format a per-iteration context window report line.
 * Example: "Context: 45.2k/200k (22.6%) | Cache hit: 78%"
 * Returns null if no token data available (or all zeros, e.g. dry-run mode).
 */
export function formatIterationContextReport(
  tokens: TokenUsage | undefined,
  cumulativeTokens: TokenSession | undefined,
  model?: string,
): string | null {
  if (!hasTokenData(tokens) && !hasTokenData(cumulativeTokens)) return null;

  const windowSize = getContextWindowSize(model);
  const input = cumulativeTokens
    ? cumulativeTokens.totalInputTokens + cumulativeTokens.totalCacheReadTokens + cumulativeTokens.totalCacheCreationTokens
    : 0;
  const pct = contextUtilization(cumulativeTokens, windowSize);
  const hitRate = cacheHitRate(cumulativeTokens);

  return `Context: ${formatTokens(input)}/${formatTokens(windowSize)} (${pct.toFixed(1)}%) | Cache hit: ${hitRate.toFixed(0)}%`;
}

/**
 * Format a session summary report with cumulative token statistics.
 * Returns null if no token data available (or all zeros, e.g. dry-run mode).
 */
export function formatSessionTokenSummary(
  tokens: TokenSession | undefined,
  model?: string,
): string | null {
  if (!tokens || !hasTokenData(tokens)) return null;

  const windowSize = getContextWindowSize(model);
  const totalInput = tokens.totalInputTokens;
  const totalOutput = tokens.totalOutputTokens;
  const totalCacheRead = tokens.totalCacheReadTokens;
  const totalCacheWrite = tokens.totalCacheCreationTokens;
  const pct = contextUtilization(tokens, windowSize);
  const hitRate = cacheHitRate(tokens);

  const parts = [
    `Input: ${formatTokens(totalInput)}`,
    `Output: ${formatTokens(totalOutput)}`,
    `Cache read: ${formatTokens(totalCacheRead)}`,
    `Cache write: ${formatTokens(totalCacheWrite)}`,
    `Context: ${pct.toFixed(1)}% of ${formatTokens(windowSize)}`,
    `Cache hit rate: ${hitRate.toFixed(0)}%`,
  ];

  return `Token summary: ${parts.join(' | ')}`;
}
