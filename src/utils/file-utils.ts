/**
 * File operation utilities
 */

import { readFile, writeFile, mkdir, copyFile, access } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { error as logError, warn } from './logger.js';

/**
 * Read and parse a JSON file
 * @throws Error if file doesn't exist or JSON is invalid
 */
export async function readJSON<T = unknown>(path: string): Promise<T> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Failed to read JSON file ${path}: ${message}`);
    throw err;
  }
}

/**
 * Write data to a JSON file with pretty formatting
 */
export async function writeJSON<T>(path: string, data: T): Promise<void> {
  try {
    const content = JSON.stringify(data, null, 2);
    await writeFile(path, content, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Failed to write JSON file ${path}: ${message}`);
    throw err;
  }
}

/**
 * Write text to a file
 */
export async function writeText(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Failed to write file ${path}: ${message}`);
    throw err;
  }
}

/**
 * Append text to a file
 */
export async function appendText(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'a' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Failed to append to file ${path}: ${message}`);
    throw err;
  }
}

/**
 * Check if a file exists
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file exists synchronously
 */
export function fileExistsSync(path: string): boolean {
  return existsSync(path);
}

/**
 * Create directory recursively if it doesn't exist
 */
export async function ensureDir(path: string): Promise<void> {
  if (existsSync(path)) {
    return;
  }

  try {
    await mkdir(path, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Failed to create directory ${path}: ${message}`);
    throw err;
  }
}

/**
 * Copy a file to a destination
 */
export async function copyFileTo(src: string, dest: string): Promise<void> {
  try {
    await ensureDir(dirname(dest));
    await copyFile(src, dest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Failed to copy file ${src} to ${dest}: ${message}`);
    throw err;
  }
}

/**
 * Read text file content
 */
export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Failed to read file ${path}: ${message}`);
    throw err;
  }
}

/**
 * Join path segments
 */
export function pathJoin(...segments: string[]): string {
  return join(...segments);
}

/**
 * Check if a target path is within an allowed root directory.
 * Resolves both paths to absolute form before comparing.
 */
export function isPathSafe(targetPath: string, allowedRoot: string): boolean {
  const resolved = resolve(targetPath);
  const resolvedRoot = resolve(allowedRoot);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + sep);
}
