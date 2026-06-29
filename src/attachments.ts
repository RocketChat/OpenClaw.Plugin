import { resolveUrl, getExt } from "./utils.js";
import type { InboundAttachment, InboundAttachmentKind, AttachmentRecord } from "./types/types.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "ogg", "oga", "opus", "wav", "flac", "aac", "amr", "weba"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt", "md", "csv", "json"]);
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

export function getMessageAttachmentInputs(message: {
  attachments?: unknown[];
  file?: unknown;
  files?: unknown[];
}): unknown[] {
  const hasId = (r: AttachmentRecord) => typeof r._id === "string" && r._id.length > 0;
  const fileRecords = toRecords([
    ...(message.file ? [message.file] : []),
    ...(message.files ?? []),
  ]);
  const fileIds = new Set(fileRecords.filter(hasId).map((r) => r._id));
  const attachmentRecords = toRecords(message.attachments ?? []).filter(
    (r) => !hasId(r) || !fileIds.has(r._id),
  );
  return [...fileRecords, ...attachmentRecords];
}

export function normalizeInboundAttachments(
  inputs: unknown[],
  options?: { serverUrl?: string },
): InboundAttachment[] {
  return inputs.map((input) => toAttachment(input, options));
}

function toAttachment(input: unknown, options?: { serverUrl?: string }): InboundAttachment {
  const record = asRecord(input);
  const mimeType = getMime(record);
  const url = getUrl(record, options?.serverUrl);
  const fileName = getFileName(record, url);
  return {
    kind: classify(mimeType, fileName),
    source: record?._id ? "rocketchat-file" : "rocketchat-attachment",
    raw: input,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(fileName !== undefined ? { fileName } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(typeof record?.size === "number" ? { sizeBytes: record.size } : {}),
  };
}

function asRecord(input: unknown): AttachmentRecord | null {
  return input && typeof input === "object" && !Array.isArray(input) ? input as AttachmentRecord : null;
}

function toRecords(inputs: unknown[]): AttachmentRecord[] {
  return inputs.map(asRecord).filter((r): r is AttachmentRecord => r !== null);
}

function getMime(record: AttachmentRecord | null): string | undefined {
  const v = record?.type ?? record?.mimeType ?? record?.mimetype ?? record?.contentType;
  return typeof v === "string" && v.trim().length > 0 ? v.trim().toLowerCase() : undefined;
}

function getUrl(record: AttachmentRecord | null, serverUrl: string | undefined): string | undefined {
  const candidates = [record?.url, record?.title_link, record?.image_url, record?.video_url, record?.audio_url];
  const raw = candidates.find((v): v is string => typeof v === "string" && v.length > 0);
  return raw ? resolveUrl(raw, serverUrl) : undefined;
}

function getFileName(record: AttachmentRecord | null, url: string | undefined): string | undefined {
  const name = [record?.title, record?.name, record?.filename].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (name) return name.trim();
  if (!url) return undefined;
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return seg ? decodeURIComponent(seg) : undefined;
  } catch { return undefined; }
}

function classify(mimeType: string | undefined, fileName: string | undefined): InboundAttachmentKind {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("text/") || (mimeType && DOCUMENT_MIME_TYPES.has(mimeType))) return "document";
  const ext = getExt(fileName);
  if (!ext) return "unknown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return "unknown";
}


