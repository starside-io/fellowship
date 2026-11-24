import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, moduleConfigSchema } from "../../src/config/index.js";
import { registry } from "../../src/tools/index.js";

/**
 * module.json and config.schema.json describe this module to a host kernel.
 * They are written by hand and read by something else, so the one thing they
 * have to keep agreeing on gets a test: the tool names, and the config keys.
 *
 * A command or a skill that calls a tool module.json does not list is a bug in
 * whichever file is behind.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, name), "utf8")) as Record<string, unknown>;
}

describe("module.json", () => {
  const manifest = readJson("module.json");
  const tools = manifest["tools"] as Record<string, string[]>;

  it("lists every tool the registry holds, under the right kind", () => {
    const declared = [...tools.read, ...tools.write, ...tools.needsOk].sort();
    const built = registry.names().sort();
    expect(declared).toEqual(built);
  });

  it("agrees with the registry about which tools need a yes", () => {
    const needsOk = registry.tools
      .filter((tool) => tool.kind === "needs-ok")
      .map((tool) => tool.name)
      .sort();
    expect([...tools.needsOk].sort()).toEqual(needsOk);
  });

  it("names the silo's tables and the module's events", () => {
    const silo = manifest["silo"] as { tables: string[]; search: string[] };
    expect(silo.tables).toContain("PersonAvatar");
    expect(silo.tables).not.toContain("AppSetting");
    expect(silo.search).toEqual(["person_fts", "note_fts", "message_fts"]);

    const events = manifest["events"] as { emits: string[] };
    expect(events.emits).toEqual([
      "people.interaction.logged",
      "people.closeness.changed",
      "people.person.created",
      "people.sketch.written",
      "people.personality.written",
    ]);
  });

  it("declares a module that reaches nothing by itself", () => {
    expect(manifest["permissions"]).toEqual({
      network: "none",
      files: "none",
      connectors: ["chat-export", "media"],
    });
  });
});

describe("config.schema.json", () => {
  const schema = readJson("config.schema.json");
  const properties = schema["properties"] as Record<string, { default?: unknown }>;

  it("declares the same keys core does", () => {
    expect(Object.keys(properties).sort()).toEqual(
      Object.keys(moduleConfigSchema.shape).sort(),
    );
  });

  it("carries the same defaults core falls back to", () => {
    expect(properties["halfLifeDays"]?.default).toBe(DEFAULT_CONFIG.halfLifeDays);
    expect(properties["scoreScale"]?.default).toBe(DEFAULT_CONFIG.scoreScale);
    expect(properties["messageChunk"]?.default).toBe(DEFAULT_CONFIG.messageChunk);

    const thresholds = (
      schema["properties"] as {
        chatThresholds: { properties: Record<string, { default: number }> };
      }
    ).chatThresholds.properties;
    for (const [key, value] of Object.entries(DEFAULT_CONFIG.chatThresholds)) {
      expect(thresholds[key]?.default, key).toBe(value);
    }
  });
});
