import { resolveUrl } from "../utils.js";
import type { InboundAttachment, InboundAttachmentKind, AttachmentRecord } from "../types.js";
import { mediaKindFromMime, mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";

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

  const hasUrl = (r: AttachmentRecord) =>
    typeof r.url === "string" ||
    typeof r.title_link === "string" ||
    typeof r.image_url === "string" ||
    typeof r.video_url === "string" ||
    typeof r.audio_url === "string";

  const merged: AttachmentRecord[] = [];
  const paired = new Set<number>();

  for (const fileRec of fileRecords) {
    const matchIdx = attachmentRecords.findIndex((att, i) =>
      !paired.has(i) && (
        (fileRec._id && att._id && fileRec._id === att._id) ||
        (!hasId(att) && hasUrl(att))
      ),
    );
    if (matchIdx !== -1) {
      paired.add(matchIdx);
      const att = attachmentRecords[matchIdx]!;
      const m = { ...att } as AttachmentRecord;
      if (fileRec._id) m._id = fileRec._id;
      if (fileRec.type) m.type = fileRec.type;
      if (fileRec.name) m.name = fileRec.name;
      if (typeof fileRec.size === "number") m.size = fileRec.size;
      merged.push(m);
    } else {
      merged.push(fileRec);
    }
  }

  for (let i = 0; i < attachmentRecords.length; i++) {
    if (!paired.has(i)) merged.push(attachmentRecords[i]!);
  }

  return merged;
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
  const mime = mimeType ?? (fileName ? mimeTypeFromFilePath(fileName) : undefined);
  const kind = mime ? mediaKindFromMime(mime) : undefined;
  return kind ?? "unknown";
}


