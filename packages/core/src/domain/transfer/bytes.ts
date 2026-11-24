// Avatar pictures are the only binary column in the database. JSON cannot hold
// bytes, so a snapshot carries them base64 encoded, which costs about a third
// more room than the raw picture.

/** Raw bytes to the base64 text that goes into a snapshot. */
export function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

/**
 * Base64 text from a snapshot back to the bytes Prisma writes. Copied out of
 * the Buffer pool so the result owns its own memory.
 */
export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(value, "base64"));
}
