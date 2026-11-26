import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { IMPORT_ROOTS_ENV } from "../src/ports/chat-file.js";
import { throwawayHost } from "./harness.js";

/**
 * people.import_chat with a filePath: the host reads the export off disk, so
 * an assistant sends a path rather than writing the whole chat out as an
 * argument. Every file here is written to a throwaway folder.
 */

interface Imported {
  ok: boolean;
  replaced: boolean;
  conversation: { id: string; fileName: string | null; messageCount: number };
  participants: Array<{ senderName: string; messageCount: number }>;
}

function folder(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A chat between Me and Sam, with the given number of lines from each. */
function chat(fromMe: number, fromSam: number): string {
  const lines: string[] = [];
  const total = fromMe + fromSam;
  let me = 0;
  let sam = 0;
  for (let index = 0; index < total; index++) {
    const minute = index % 60;
    const hour = Math.floor(index / 60) % 24;
    const day = 1 + (Math.floor(index / 1440) % 28);
    const stamp = `${String(day).padStart(2, "0")}/05/2026, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const fromMeNext = me < fromMe && (index % 2 === 0 || sam >= fromSam);
    if (fromMeNext) {
      lines.push(`${stamp} - Me: line ${index} about the walk on Saturday`);
      me++;
    } else {
      lines.push(`${stamp} - Sam: line ${index}, sounds good to me`);
      sam++;
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A minimal zip writer: stored or deflated entries, no zip64. */
function zip(files: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const body = file.deflate ? deflateRawSync(file.data) : file.data;
    const method = file.deflate ? 8 : 0;
    const crc = crc32(file.data);
    const name = Buffer.from(file.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(file.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function counts(result: Imported): Record<string, number> {
  return Object.fromEntries(
    result.participants.map((participant) => [participant.senderName, participant.messageCount]),
  );
}

async function hostWithRoot() {
  const root = folder("fellowship-imports-");
  const host = await throwawayHost({ env: { [IMPORT_ROOTS_ENV]: root } });
  return { root, host };
}

describe("people.import_chat from a file", () => {
  it("reads a .txt into exactly what the same text imports, BOM and all", async () => {
    const { root, host } = await hostWithRoot();
    try {
      const text = chat(97, 88);
      const path = join(root, "WhatsApp Chat with Sam.txt");
      writeFileSync(path, `﻿${text}`);

      const fromText = (await host.api.invoke("people.import_chat", {
        text,
        selfName: "Me",
      })) as Imported;
      const fromFile = (await host.api.invoke("people.import_chat", {
        filePath: path,
        selfName: "Me",
      })) as Imported;

      expect(fromText.ok).toBe(true);
      expect(fromFile.ok).toBe(true);
      expect(counts(fromFile)).toEqual({ Me: 97, Sam: 88 });
      expect(counts(fromFile)).toEqual(counts(fromText));
      expect(Object.keys(fromFile).sort()).toEqual(Object.keys(fromText).sort());

      // The same code path: the second import rewrote the first.
      expect(fromFile.replaced).toBe(true);
      expect(fromFile.conversation.id).toBe(fromText.conversation.id);
      expect(await host.silo.conversation.count()).toBe(1);
      expect(fromFile.conversation.fileName).toBe("WhatsApp Chat with Sam.txt");
    } finally {
      await host.close();
    }
  });

  it("imports a 1 MB export in one call", async () => {
    const { root, host } = await hostWithRoot();
    try {
      const text = chat(9000, 9000);
      expect(Buffer.byteLength(text)).toBeGreaterThan(1_000_000);
      const path = join(root, "big.txt");
      writeFileSync(path, text);

      const result = (await host.api.invoke("people.import_chat", {
        filePath: path,
        selfName: "Me",
        fileName: "chat with Sam",
      })) as Imported;

      expect(result.ok).toBe(true);
      expect(result.conversation.messageCount).toBe(18000);
      expect(result.conversation.fileName).toBe("chat with Sam");
    } finally {
      await host.close();
    }
  });

  it("reads _chat.txt out of a WhatsApp zip and leaves the media alone", async () => {
    const { root, host } = await hostWithRoot();
    try {
      const path = join(root, "WhatsApp Chat - Sam.zip");
      writeFileSync(
        path,
        zip([
          { name: "00000012-PHOTO-2026-05-01.jpg", data: Buffer.alloc(4096, 0xab) },
          { name: "_chat.txt", data: Buffer.from(chat(5, 4)), deflate: true },
          { name: "00000013-AUDIO-2026-05-01.opus", data: Buffer.alloc(2048, 0xcd) },
        ]),
      );

      const result = (await host.api.invoke("people.import_chat", {
        filePath: path,
        selfName: "Me",
      })) as Imported;

      expect(result.ok).toBe(true);
      expect(counts(result)).toEqual({ Me: 5, Sam: 4 });
      expect(result.conversation.fileName).toBe("WhatsApp Chat - Sam.zip");
      expect(await host.silo.message.count()).toBe(9);
    } finally {
      await host.close();
    }
  });

  it("takes the one .txt in a zip that has no _chat.txt", async () => {
    const { root, host } = await hostWithRoot();
    try {
      const path = join(root, "export.zip");
      writeFileSync(
        path,
        zip([
          { name: "photo.jpg", data: Buffer.alloc(512, 1) },
          { name: "WhatsApp Chat with Sam.txt", data: Buffer.from(chat(2, 2)) },
        ]),
      );

      const result = (await host.api.invoke("people.import_chat", {
        filePath: path,
        selfName: "Me",
      })) as Imported;
      expect(counts(result)).toEqual({ Me: 2, Sam: 2 });
    } finally {
      await host.close();
    }
  });

  it("refuses a zip with no .txt in it", async () => {
    const { root, host } = await hostWithRoot();
    try {
      const path = join(root, "photos.zip");
      writeFileSync(path, zip([{ name: "photo.jpg", data: Buffer.alloc(512, 1) }]));

      await expect(
        host.api.invoke("people.import_chat", { filePath: path }),
      ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/no \.txt/) });
      expect(await host.silo.conversation.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("refuses a path outside the import folders, and a link that leads out of one", async () => {
    const { root, host } = await hostWithRoot();
    try {
      const elsewhere = folder("fellowship-elsewhere-");
      const outside = join(elsewhere, "chat.txt");
      writeFileSync(outside, chat(3, 3));

      await expect(
        host.api.invoke("people.import_chat", { filePath: outside }),
      ).rejects.toMatchObject({ code: "refused" });

      const link = join(root, "looks-inside.txt");
      symlinkSync(outside, link);
      await expect(
        host.api.invoke("people.import_chat", { filePath: link }),
      ).rejects.toMatchObject({ code: "refused" });

      // ".." is resolved before the check, not after.
      mkdirSync(join(root, "sub"));
      await expect(
        host.api.invoke("people.import_chat", {
          filePath: join(root, "sub", "..", "..", elsewhere.split("/").pop()!, "chat.txt"),
        }),
      ).rejects.toMatchObject({ code: "refused" });

      expect(await host.silo.conversation.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("says so when the file is missing, too large, or not an export", async () => {
    const { root, host } = await hostWithRoot();
    try {
      await expect(
        host.api.invoke("people.import_chat", { filePath: join(root, "nope.txt") }),
      ).rejects.toMatchObject({ code: "not_found" });

      const huge = join(root, "huge.txt");
      writeFileSync(huge, "");
      truncateSync(huge, 20_000_001);
      await expect(
        host.api.invoke("people.import_chat", { filePath: huge }),
      ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/20 MB/) });

      const pdf = join(root, "chat.pdf");
      writeFileSync(pdf, "not a chat");
      await expect(
        host.api.invoke("people.import_chat", { filePath: pdf }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      const latin1 = join(root, "latin1.txt");
      writeFileSync(latin1, Buffer.from([0x30, 0x31, 0x2f, 0xe9, 0xff, 0x0a]));
      await expect(
        host.api.invoke("people.import_chat", { filePath: latin1 }),
      ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/UTF-8/) });

      expect(await host.silo.conversation.count()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("takes exactly one of text and filePath", async () => {
    const { root, host } = await hostWithRoot();
    try {
      const path = join(root, "chat.txt");
      writeFileSync(path, chat(2, 2));

      await expect(
        host.api.invoke("people.import_chat", { text: chat(2, 2), filePath: path }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(host.api.invoke("people.import_chat", {})).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(await host.silo.conversation.count()).toBe(0);
    } finally {
      await host.close();
    }
  });
});
