import { avatarUrl, rpc } from "@/client";

/** Hands the browser a file to save, from text already in memory. */
export function saveText(text: string, fileName: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // Revoked on the next tick: some engines start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * A stored picture as base64 JPEG, through a canvas, for a card whose picture
 * is in a format contact apps do not import. Null when it cannot be drawn.
 */
async function pictureAsJpeg(personId: string): Promise<string | null> {
  try {
    const response = await fetch(avatarUrl(personId));
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    // Contacts keeps a small square; 512 is plenty and keeps the file light.
    const side = Math.min(512, bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const crop = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - crop) / 2,
      (bitmap.height - crop) / 2,
      crop,
      crop,
      0,
      0,
      side,
      side,
    );
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  } catch {
    return null;
  }
}

/** A long vCard line folded at 75 octets. Base64 is ASCII, so octets are characters. */
function fold(line: string): string {
  const parts = [line.slice(0, 75)];
  for (let index = 75; index < line.length; index += 74) parts.push(line.slice(index, index + 74));
  return parts.join("\r\n ");
}

/** Adds a PHOTO line to the card with this UID, just before its END. */
function withPhoto(vcard: string, personId: string, base64: string): string {
  const uid = `UID:urn:uuid:${personId}`;
  const start = vcard.indexOf(uid);
  if (start === -1) return vcard;
  const end = vcard.indexOf("END:VCARD", start);
  if (end === -1) return vcard;
  const line = `${fold(`PHOTO;ENCODING=b;TYPE=JPEG:${base64}`)}\r\n`;
  return `${vcard.slice(0, end)}${line}${vcard.slice(end)}`;
}

/**
 * Contact cards for one person, several, or everyone (no ids), as a .vcf a
 * phone or Contacts imports. Returns how many cards the file holds.
 */
export async function downloadVCards(personIds?: string[]): Promise<number> {
  const result = await rpc<{
    fileName: string;
    mime: string;
    count: number;
    vcard: string;
    photoless: string[];
  }>("people.vcard", personIds ? { personIds } : {});

  let vcard = result.vcard;
  for (const personId of result.photoless) {
    const jpeg = await pictureAsJpeg(personId);
    if (jpeg) vcard = withPhoto(vcard, personId, jpeg);
  }

  saveText(vcard, result.fileName, result.mime);
  return result.count;
}
