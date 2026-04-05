/**
 * Formatting utilities
 */

/**
 * Format a duration in milliseconds to a human-readable string.
 * - < 60s: "45.2s"
 * - 60s–1h: "3m 6s"
 * - > 1h: "1h 2m 30s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (totalSeconds >= 60) {
    return `${minutes}m ${seconds}s`;
  }

  return `${(ms / 1000).toFixed(1)}s`;
}
