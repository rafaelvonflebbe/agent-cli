/**
 * Telegram notification — sends a message when a user story is completed.
 * Optional: silently skips if TELEGRAM_TOKEN or TELEGRAM_CHAT_ID are not set.
 * Uses native fetch (Node 18+) — no new dependencies.
 */

import type { FileChange } from '../utils/git-utils.js';
import { info, warn } from '../utils/logger.js';

/** POST to Telegram Bot API */
async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<boolean> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      warn(`Telegram notification failed (${res.status}): ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Telegram notification error: ${message}`);
    return false;
  }
}

/**
 * Build a Telegram notification message for a completed story.
 */
function buildMessage(
  project: string,
  story: { id: string; title: string },
  changes: FileChange[],
): string {
  const lines: string[] = [
    `<b>✅ Story completed</b>`,
    `<b>Project:</b> ${project}`,
    `<b>Story:</b> ${story.id} — ${story.title}`,
  ];

  if (changes.length > 0) {
    lines.push(`<b>Files changed:</b>`);
    for (const c of changes.slice(0, 20)) {
      const icon = c.type === 'removed' ? '🗑' : c.type === 'added' ? '➕' : '✏️';
      lines.push(`  ${icon} ${c.path}`);
    }
    if (changes.length > 20) {
      lines.push(`  … and ${changes.length - 20} more`);
    }
  }

  return lines.join('\n');
}

/**
 * Send a Telegram notification for a completed story.
 * Returns true if sent successfully, false otherwise.
 * Silently skips if env vars are not configured.
 */
export async function notifyStoryComplete(
  project: string,
  story: { id: string; title: string },
  changes: FileChange[],
): Promise<boolean> {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    // Not configured — silently skip
    return false;
  }

  const text = buildMessage(project, story, changes);
  const ok = await sendTelegramMessage(token, chatId, text);

  if (ok) {
    info(`Telegram notification sent for story ${story.id}`);
  }

  return ok;
}

/**
 * Check if Telegram notifications are configured.
 */
export function isTelegramConfigured(): boolean {
  return !!(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID);
}
