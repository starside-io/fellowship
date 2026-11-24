import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Reading a Tiptap document back out.
 *
 * Notes and occasion descriptions are stored as Tiptap JSON, and this renders
 * that JSON: paragraphs, headings, the three marks a note actually uses, lists,
 * quotes and code. Writing one is a plain textarea for now, which is honest
 * about what it produces: the editor itself arrives with the rest of the rich
 * text work, and until then nothing here pretends a document is a string.
 */

interface Node {
  type?: string;
  text?: string;
  content?: Node[];
  marks?: Array<{ type?: string }>;
  attrs?: Record<string, unknown>;
}

export function RichText({
  doc,
  className,
  empty = "Nothing written.",
}: {
  doc: unknown;
  className?: string;
  empty?: string;
}) {
  const root = doc as Node | null | undefined;
  const children = root?.content ?? [];

  if (children.length === 0) {
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  }

  return (
    <div className={cn("space-y-2 text-sm leading-relaxed", className)}>
      {children.map((node, index) => (
        <Block key={index} node={node} />
      ))}
    </div>
  );
}

function Block({ node }: { node: Node }): ReactNode {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.["level"] ?? 2);
      return (
        <p className={cn("font-heading font-semibold", level <= 2 ? "text-base" : "text-sm")}>
          <Inline nodes={node.content ?? []} />
        </p>
      );
    }
    case "bulletList":
      return (
        <ul className="list-disc space-y-1 pl-5">
          {(node.content ?? []).map((item, index) => (
            <li key={index}>
              <Inline nodes={flatten(item)} />
            </li>
          ))}
        </ul>
      );
    case "orderedList":
      return (
        <ol className="list-decimal space-y-1 pl-5">
          {(node.content ?? []).map((item, index) => (
            <li key={index}>
              <Inline nodes={flatten(item)} />
            </li>
          ))}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote className="border-border text-muted-foreground border-l-2 pl-3 italic">
          <Inline nodes={flatten(node)} />
        </blockquote>
      );
    case "codeBlock":
      return (
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
          <code>{plainText(node)}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr className="border-border" />;
    default:
      return (
        <p>
          <Inline nodes={node.content ?? []} />
        </p>
      );
  }
}

function Inline({ nodes }: { nodes: Node[] }): ReactNode {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.type === "hardBreak") return <br key={index} />;
        const text = node.text ?? "";
        if (!text) return null;

        const marks = new Set((node.marks ?? []).map((mark) => mark.type));
        let element: ReactNode = text;
        if (marks.has("code")) {
          element = <code className="bg-muted rounded px-1 py-0.5 text-xs">{element}</code>;
        }
        if (marks.has("bold")) element = <strong>{element}</strong>;
        if (marks.has("italic")) element = <em>{element}</em>;
        if (marks.has("strike")) element = <s>{element}</s>;

        return <span key={index}>{element}</span>;
      })}
    </>
  );
}

/** The inline nodes of a block, however deeply a list wrapped them. */
function flatten(node: Node): Node[] {
  const out: Node[] = [];
  for (const child of node.content ?? []) {
    if (child.text !== undefined || child.type === "hardBreak") out.push(child);
    else out.push(...flatten(child));
  }
  return out;
}

/** The plain text of a document, for a code block or a one line preview. */
export function plainText(doc: unknown): string {
  const node = doc as Node | null | undefined;
  if (!node) return "";
  const own = node.text ?? "";
  const children = (node.content ?? []).map((child) => plainText(child)).join("");
  const separator = node.type === "paragraph" || node.type === "heading" ? "\n" : "";
  return `${own}${children}${separator}`;
}

/**
 * Plain text to a document, for the textarea that writes one. Blank lines
 * split paragraphs, which is the one piece of structure a plain field can
 * honestly carry.
 */
export function toDoc(text: string): { type: "doc"; content: unknown[] } {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return {
    type: "doc",
    content:
      paragraphs.length === 0
        ? [{ type: "paragraph" }]
        : paragraphs.map((block) => ({
            type: "paragraph",
            content: block.split("\n").flatMap((line, index) =>
              index === 0
                ? [{ type: "text", text: line }]
                : [{ type: "hardBreak" }, { type: "text", text: line }],
            ),
          })),
  };
}
