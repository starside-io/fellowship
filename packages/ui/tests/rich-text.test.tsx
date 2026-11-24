import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RichText, plainText, toDoc } from "@/app/components/rich-text";

/**
 * Notes and occasion descriptions are documents, not strings. The textarea
 * that writes one has to produce a document the core will accept, and the
 * reader has to show one without losing what is in it.
 */

// globals are off in this package, so the automatic cleanup is wired by hand.
afterEach(cleanup);

describe("toDoc", () => {
  it("makes a document the snapshot schema would accept", () => {
    const doc = toDoc("first line");
    expect(doc.type).toBe("doc");
    expect(doc.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "first line" }] },
    ]);
  });

  it("splits paragraphs on a blank line and keeps single breaks", () => {
    const doc = toDoc("one\ntwo\n\nthree");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "one" },
        { type: "hardBreak" },
        { type: "text", text: "two" },
      ],
    });
  });

  it("makes an empty paragraph rather than an empty document", () => {
    expect(toDoc("   ").content).toEqual([{ type: "paragraph" }]);
  });
});

describe("plainText", () => {
  it("reads a document back as text", () => {
    expect(plainText(toDoc("one\n\ntwo")).trim()).toBe("one\ntwo");
  });
});

describe("RichText", () => {
  it("renders paragraphs, marks and lists", () => {
    render(
      <RichText
        doc={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "plain " },
                { type: "text", text: "bold", marks: [{ type: "bold" }] },
              ],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "a point" }] },
                  ],
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("a point")).toBeDefined();
    expect(screen.getByRole("list")).toBeDefined();
  });

  it("says a document is empty rather than rendering nothing", () => {
    render(<RichText doc={{ type: "doc", content: [] }} empty="Nothing written." />);
    expect(screen.getByText("Nothing written.")).toBeDefined();
  });

  it("survives a document shape it has never seen", () => {
    const { container } = render(
      <RichText doc={{ type: "doc", content: [{ type: "mysteryBlock" }] }} />,
    );
    // An unknown block renders as an empty paragraph rather than throwing.
    expect(container.textContent).toBe("");
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});
