import { open, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, extname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

import { tools as coreTools } from "@fellowship/core";
import type { ChatExportFile } from "@fellowship/core";

const { ToolError } = coreTools;

/**
 * Reading one exported chat off disk for people.import_chat.
 *
 * An assistant that passes a chat as a tool argument has to write every
 * character of it out, so its output length becomes a hidden ceiling on what
 * can be imported. A path is a few dozen characters at any size.
 *
 * Only files under the import roots are read: Downloads, Desktop, Documents
 * and the inbox by default, or the folders FELLOWSHIP_IMPORT_ROOTS names. The
 * path is resolved through symlinks and ".." first, so a link inside a root
 * that points out of it is refused.
 */

export const IMPORT_ROOTS_ENV = "FELLOWSHIP_IMPORT_ROOTS";

/**
 * The ceiling people.import_chat puts on pasted text. UTF-8 never takes fewer
 * bytes than characters, so a file under it holds a text under it.
 */
export const MAX_CHAT_BYTES = 20_000_000;

/** Biggest central directory read from a zip: room for a few hundred thousand media files. */
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** The folders a chat may be imported from, as configured. */
export function resolveImportRoots(env: NodeJS.ProcessEnv, inbox: string): string[] {
  const override = env[IMPORT_ROOTS_ENV]?.trim();
  if (override) {
    return override
      .split(delimiter)
      .map((root) => root.trim())
      .filter(Boolean);
  }
  const home = homedir();
  return [join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents"), inbox];
}

export async function readChatExportFile(
  path: string,
  roots: readonly string[],
): Promise<ChatExportFile> {
  const requested = resolve(expandHome(path.trim()));

  let real: string;
  try {
    real = await realpath(requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new ToolError("not_found", `There is no file at ${requested}.`);
    }
    throw new ToolError("unavailable", `Could not open ${requested}: ${(error as Error).message}`);
  }

  const allowed = await realRoots(roots);
  if (!allowed.some((root) => isInside(real, root))) {
    throw new ToolError(
      "refused",
      `${requested} is outside the folders a chat can be imported from (${roots.join(", ")}). Move the export into one of them, or list its folder in ${IMPORT_ROOTS_ENV}.`,
    );
  }

  const info = await stat(real);
  if (!info.isFile()) {
    throw new ToolError("invalid_input", `${requested} is a folder, not a chat export.`);
  }

  const extension = extname(real).toLowerCase();
  let bytes: Buffer;
  if (extension === ".txt") {
    if (info.size > MAX_CHAT_BYTES) throw tooLarge(requested, info.size);
    bytes = await readFile(real);
  } else if (extension === ".zip") {
    bytes = await readChatFromZip(real, requested);
  } else {
    throw new ToolError(
      "invalid_input",
      `${basename(requested)} is not a chat export. Pass the .txt or the .zip WhatsApp's Export chat wrote.`,
    );
  }

  const text = decode(bytes, requested);
  if (text.trim() === "") {
    throw new ToolError("invalid_input", `${requested} is empty.`);
  }
  return { fileName: basename(requested), text };
}

async function realRoots(roots: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    try {
      found.push(await realpath(resolve(expandHome(root))));
    } catch {
      // A root that does not exist holds nothing to import.
    }
  }
  return found;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function tooLarge(shown: string, size: number): Error {
  const mb = (size / 1_000_000).toFixed(1);
  return new ToolError(
    "invalid_input",
    `${shown} holds ${mb} MB of chat text, over the 20 MB a chat import takes.`,
  );
}

/** UTF-8, or UTF-16 when the file starts with its byte order mark. A leading BOM is dropped. */
function decode(bytes: Buffer, shown: string): string {
  let text: string;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
    } else {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  } catch {
    throw new ToolError(
      "invalid_input",
      `${shown} is not readable as UTF-8 text. Export the chat again, or save the file as UTF-8.`,
    );
  }
  return text.replace(/^﻿/, "");
}

// The zip side. WhatsApp's Export chat writes the chat as _chat.txt beside the
// media; only the text entry is read, and the media is never inflated.

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

async function readChatFromZip(real: string, shown: string): Promise<Buffer> {
  const handle = await open(real, "r");
  try {
    const { size } = await handle.stat();
    const entries = await centralDirectory(handle, size, shown);
    const entry = pickChatEntry(entries, shown);
    if (entry.uncompressedSize > MAX_CHAT_BYTES || entry.compressedSize > MAX_CHAT_BYTES) {
      throw tooLarge(`${shown} (${entry.name})`, entry.uncompressedSize);
    }
    return await entryBytes(handle, entry, shown);
  } finally {
    await handle.close();
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function notZip(shown: string, why: string): Error {
  return new ToolError("invalid_input", `${shown} could not be read as a zip: ${why}.`);
}

async function centralDirectory(
  handle: FileHandle,
  size: number,
  shown: string,
): Promise<ZipEntry[]> {
  // The end of central directory record sits in the last 22 bytes plus a
  // comment of up to 64 KB.
  const tailLength = Math.min(size, 22 + 0xffff);
  const tailStart = size - tailLength;
  const tail = await readAt(handle, tailStart, tailLength);

  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tail.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw notZip(shown, "no end of archive record");

  let count = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);

  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    // Zip64: a locator just before the record points at the real one.
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) {
      throw notZip(shown, "a zip64 archive with no locator");
    }
    const recordOffset = Number(tail.readBigUInt64LE(locator + 8));
    const record = await readAt(handle, recordOffset, 56);
    if (record.length < 56 || record.readUInt32LE(0) !== 0x06064b50) {
      throw notZip(shown, "a zip64 archive with no end record");
    }
    count = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
  }

  if (directorySize > MAX_CENTRAL_DIRECTORY || directoryOffset + directorySize > size) {
    throw notZip(shown, "a damaged file list");
  }

  const directory = await readAt(handle, directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let at = 0;
  while (entries.length < count && at + 46 <= directory.length) {
    if (directory.readUInt32LE(at) !== 0x02014b50) throw notZip(shown, "a damaged file list");
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const entry: ZipEntry = {
      name: directory.toString("utf8", at + 46, at + 46 + nameLength),
      flags: directory.readUInt16LE(at + 8),
      method: directory.readUInt16LE(at + 10),
      compressedSize: directory.readUInt32LE(at + 20),
      uncompressedSize: directory.readUInt32LE(at + 24),
      localHeaderOffset: directory.readUInt32LE(at + 42),
    };
    readZip64Extra(
      directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
      entry,
    );
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Fills in the sizes and offset a zip64 entry keeps in its extra field. */
function readZip64Extra(extra: Buffer, entry: ZipEntry): void {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === 0x0001) {
      let field = at + 4;
      const next = () => {
        const value = Number(extra.readBigUInt64LE(field));
        field += 8;
        return value;
      };
      if (entry.uncompressedSize === 0xffffffff) entry.uncompressedSize = next();
      if (entry.compressedSize === 0xffffffff) entry.compressedSize = next();
      if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = next();
      return;
    }
    at += 4 + length;
  }
}

function pickChatEntry(entries: ZipEntry[], shown: string): ZipEntry {
  const texts = entries.filter(
    (entry) =>
      !entry.name.endsWith("/") &&
      !entry.name.startsWith("__MACOSX/") &&
      entry.name.toLowerCase().endsWith(".txt"),
  );
  const named = texts.filter((entry) => entry.name.split("/").pop() === "_chat.txt");

  if (named.length === 1) return named[0]!;
  if (named.length === 0 && texts.length === 1) return texts[0]!;
  if (texts.length === 0) {
    throw new ToolError("invalid_input", `${shown} has no .txt chat inside it.`);
  }
  throw new ToolError(
    "invalid_input",
    `${shown} holds several .txt files and no single _chat.txt. Unzip it and pass the chat's .txt.`,
  );
}

async function entryBytes(handle: FileHandle, entry: ZipEntry, shown: string): Promise<Buffer> {
  if (entry.flags & 0x1) {
    throw new ToolError("invalid_input", `${shown} is password protected.`);
  }

  const local = await readAt(handle, entry.localHeaderOffset, 30);
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) {
    throw notZip(shown, `a damaged entry for ${entry.name}`);
  }
  const dataStart = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = await readAt(handle, dataStart, entry.compressedSize);
  if (data.length < entry.compressedSize) throw notZip(shown, `${entry.name} is cut short`);

  if (entry.method === 0) return data;
  if (entry.method !== 8) {
    throw new ToolError(
      "invalid_input",
      `${shown} uses a compression Fellowship cannot unpack (method ${entry.method}). Unzip it and pass the .txt.`,
    );
  }
  try {
    return inflateRawSync(data, { maxOutputLength: MAX_CHAT_BYTES });
  } catch (error) {
    if (error instanceof RangeError || (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw tooLarge(`${shown} (${entry.name})`, MAX_CHAT_BYTES + 1);
    }
    throw notZip(shown, `${entry.name} could not be unpacked`);
  }
}
