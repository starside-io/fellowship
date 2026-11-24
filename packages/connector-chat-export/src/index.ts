/**
 * The chat export connector.
 *
 * It owns the parser, which is pure: text in, a conversation or a failure out.
 * Nothing here reads a file, reaches a database or knows what a silo is. The
 * host reads the file and the module stores the rows; this is the piece in the
 * middle that understands what an export actually says, and it is a package of
 * its own because that understanding is the part most likely to be wanted by
 * something that is not this app.
 */
export * from "./parse.js";
