import type { WatchdogStage, ReplyPayload, ReplyProgressState } from "./types/types.js";

export const THINKING_PLACEHOLDER = "Thinking...";
export const EMPTY_REPLY_FALLBACK = "(no reply generated)";
const TOOL_REPLY_FALLBACK = "Tool in use...";
const BLOCK_REPLY_FALLBACK = "Building reply...";
const FAILED_REPLY_FALLBACK = "Failed to generate a reply. Please try again.";

const TOOL_PROGRESS_HEADER = "Working on it...";

const MAX_PROGRESS_LINES = 6;

export const WATCHDOG_STAGES: WatchdogStage[] = [
  { afterSeconds: 60, text: "Still thinking... (1m+)" },
  { afterSeconds: 300, text: "Taking longer than usual (5m+)" },
  { afterSeconds: 900, text: "No response received. Please try again.", terminal: true },
];

export function createReplyProgressState(): ReplyProgressState {
  return { lines: [] };
}

function formatFinalReply(reply: string): string {
  return reply.trim().length > 0 ? reply : EMPTY_REPLY_FALLBACK;
}

function renderToolProgress(lines: string[]): string {
  if (lines.length === 0) {
    return TOOL_PROGRESS_HEADER;
  }
  return [TOOL_PROGRESS_HEADER, ...lines].join("\n");
}

export function formatReplyUpdate(
  kind: "tool" | "block" | "final",
  payload: ReplyPayload,
  progress?: ReplyProgressState,
): string {
  const content = formatReplyPayload(payload);

  if (kind === "final") {
    return formatFinalReply(content);
  }

  if (kind === "tool") {
    if (!progress) {
      return content.length > 0 ? content : TOOL_REPLY_FALLBACK;
    }
    if (content.length > 0) {
      if (progress.lines[progress.lines.length - 1] !== content) {
        progress.lines.push(content);
        if (progress.lines.length > MAX_PROGRESS_LINES) {
          progress.lines.splice(0, progress.lines.length - MAX_PROGRESS_LINES);
        }
      }
    }
    return renderToolProgress(progress.lines);
  }

  if (content.length > 0) {
    return content;
  }

  return BLOCK_REPLY_FALLBACK;
}

export function formatReplyFailure(): string {
  return FAILED_REPLY_FALLBACK;
}

function formatReplyPayload(payload: ReplyPayload): string {
  const parts: string[] = [];
  const text = payload.text?.trim();
  if (text) {
    parts.push(text);
  }

  const mediaUrls = [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (mediaUrls.length > 0) {
    parts.push(mediaUrls.join("\n"));
  }

  return parts.join("\n\n").trim();
}
