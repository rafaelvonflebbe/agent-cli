/**
 * Logging utilities with colors
 */

import chalk from 'chalk';

/**
 * Log levels
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SUCCESS = 4,
}

/**
 * Logger configuration
 */
interface LoggerConfig {
  level: LogLevel;
  useColors: boolean;
  timestamps: boolean;
}

const config: LoggerConfig = {
  level: LogLevel.INFO,
  useColors: true,
  timestamps: true,
};

/**
 * Get timestamp string
 */
function getTimestamp(): string {
  return config.timestamps ? new Date().toISOString() : '';
}

/**
 * Format log message
 */
function formatMessage(level: string, message: string, color: (msg: string) => string): string {
  const timestamp = getTimestamp();
  const levelStr = timestamp ? `[${timestamp}] [${level}]` : `[${level}]`;
  return config.useColors ? color(levelStr) + ' ' + message : `${levelStr} ${message}`;
}

/**
 * Log debug message
 */
export function debug(message: string): void {
  if (config.level <= LogLevel.DEBUG) {
    console.log(formatMessage('DEBUG', message, chalk.gray));
  }
}

/**
 * Log info message
 */
export function info(message: string): void {
  if (config.level <= LogLevel.INFO) {
    console.log(formatMessage('INFO', message, chalk.blue));
  }
}

/**
 * Log warning message
 */
export function warn(message: string): void {
  if (config.level <= LogLevel.WARN) {
    console.warn(formatMessage('WARN', message, chalk.yellow));
  }
}

/**
 * Log error message
 */
export function error(message: string): void {
  if (config.level <= LogLevel.ERROR) {
    console.error(formatMessage('ERROR', message, chalk.red));
  }
}

/**
 * Log success message
 */
export function success(message: string): void {
  if (config.level <= LogLevel.SUCCESS) {
    console.log(formatMessage('SUCCESS', message, chalk.green));
  }
}

/**
 * Log iteration header
 */
export function iterationHeader(iteration: number, total: number, tool: string, story?: { id: string; title: string; priority: number }): void {
  const line = '='.repeat(64);
  console.log('\n' + chalk.cyan(line));
  console.log(chalk.cyan(`  Agent CLI Iteration ${iteration} of ${total} (${tool})`));
  if (story) {
    console.log(chalk.cyan(`  Target: ${story.id} "${story.title}" (priority ${story.priority})`));
  }
  console.log(chalk.cyan(line) + '\n');
}

/**
 * Set log level
 */
export function setLevel(level: LogLevel): void {
  config.level = level;
}

/**
 * Enable/disable colors
 */
export function setColors(enabled: boolean): void {
  config.useColors = enabled;
}

/**
 * Enable/disable timestamps
 */
export function setTimestamps(enabled: boolean): void {
  config.timestamps = enabled;
}
