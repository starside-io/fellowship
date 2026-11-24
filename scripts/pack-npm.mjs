#!/usr/bin/env node
// Packs Fellowship as one npm package, @starside/fellowship.
//
//   node scripts/pack-npm.mjs            build, assemble .npm-package/, npm pack it
//   node scripts/pack-npm.mjs --no-build assemble from the dist folders as they are
//
// The workspace packages are not on npm, so they travel inside this one as
// bundled dependencies: node_modules/@fellowship/{core,mini-host,connector-chat-export}
// with their compiled dist. Everything they import from npm is an ordinary
// dependency of the package, installed beside it, so a native module such as
// sharp resolves for whatever machine installs it.
//
// The Prisma client is the one platform specific piece that is generated, not
// installed: postinstall runs `prisma generate` against the schema core ships,
// which writes the client and the query engine for the installing machine.
//
// Publishing is a separate, deliberate step: `npm publish .npm-package`.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".npm-package");

const NAME = "@starside/fellowship";

/** The workspace packages the CLI needs at runtime, bundled inside the package. */
const BUNDLED = [
  { name: "@fellowship/core", dir: "packages/core", extra: [] },
  { name: "@fellowship/mini-host", dir: "packages/mini-host", extra: [] },
  { name: "@fellowship/connector-chat-export", dir: "packages/connector-chat-export", extra: [] },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, cwd = root) {
  process.stdout.write(`> ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

if (!process.argv.includes("--no-build")) {
  run("pnpm", ["--filter", "@fellowship/core", "db:generate"]);
  run("pnpm", ["build"]);
}

const rootPkg = readJson(join(root, "package.json"));
const cliPkg = readJson(join(root, "apps/fellowship/package.json"));

for (const path of [
  "apps/fellowship/dist/cli.js",
  "packages/ui/dist/index.html",
  "packages/core/dist/storage/schema.prisma",
  "packages/core/dist/storage/migrations",
]) {
  if (!existsSync(join(root, path))) throw new Error(`Missing ${path}. Build first.`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The CLI, runnable as a bin: npm needs the shebang the desktop app does not.
cpSync(join(root, "apps/fellowship/dist"), join(out, "dist"), { recursive: true });
const cli = join(out, "dist/cli.js");
writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(cli, "utf8")}`);
chmodSync(cli, 0o755);

// The UI the host serves; the CLI finds it at ../ui.
cpSync(join(root, "packages/ui/dist"), join(out, "ui"), { recursive: true });

// The workspace packages, with their npm dependencies lifted to the top so npm
// installs them beside the package rather than inside each bundled copy.
const dependencies = {};
for (const bundled of BUNDLED) {
  const pkg = readJson(join(root, bundled.dir, "package.json"));
  for (const [dep, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!String(version).startsWith("workspace:")) dependencies[dep] = version;
  }
  const target = join(out, "node_modules", bundled.name);
  mkdirSync(target, { recursive: true });
  cpSync(join(root, bundled.dir, "dist"), join(target, "dist"), { recursive: true });
  const { scripts, devDependencies, dependencies: _deps, files, ...kept } = pkg;
  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify({ ...kept, private: undefined, dependencies: {} }, null, 2)}\n`,
  );
}
// The Prisma CLI generates the client at install.
const prismaVersion = readJson(join(root, "packages/core/package.json")).devDependencies.prisma;
dependencies.prisma = prismaVersion;

// npm only packs a bundled dependency that is also listed as a dependency.
// The bundled copy is what installs; the version is never fetched.
for (const bundled of BUNDLED) {
  dependencies[bundled.name] = readJson(join(root, bundled.dir, "package.json")).version;
}

const sortedDependencies = Object.fromEntries(
  Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
);

const manifest = {
  name: NAME,
  version: rootPkg.version,
  description:
    "Fellowship: a local-first record of the people in your life. The host, the UI and the MCP server in one package. Run `fellowship serve` for the app, `fellowship mcp` for an assistant.",
  license: "Apache-2.0",
  author: "starside.io (https://starside.io)",
  homepage: "https://starside.io/projects/fellowship",
  repository: { type: "git", url: "git+https://github.com/starside-io/fellowship.git" },
  keywords: ["people", "relationships", "local-first", "sqlite", "mcp", "personal-crm"],
  type: "module",
  engines: { node: ">=22.5" },
  bin: { fellowship: "dist/cli.js" },
  files: ["dist", "ui", "node_modules/@fellowship", "LICENSE", "README.md"],
  scripts: {
    postinstall:
      "prisma generate --schema node_modules/@fellowship/core/dist/storage/schema.prisma",
  },
  dependencies: sortedDependencies,
  bundleDependencies: BUNDLED.map((bundled) => bundled.name),
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
writeFileSync(
  join(out, "README.md"),
  `# Fellowship

A local-first record of the people in your life: who they are, what they like,
what to steer clear of, the moments you shared, and how close you are. One
SQLite file on your machine, and any AI assistant can draft into it through MCP,
with every draft waiting for your yes.

\`\`\`bash
npx @starside/fellowship serve     # the app, at http://localhost:4319
npx @starside/fellowship mcp       # the MCP server, on stdio
\`\`\`

As an MCP server for any client:

\`\`\`json
{ "command": "npx", "args": ["-y", "@starside/fellowship", "mcp"] }
\`\`\`

Needs Node 22.5 or later. Everything else, including the Claude Code plugin,
is at [github.com/starside-io/fellowship](https://github.com/starside-io/fellowship).

Built by [starside.io](https://starside.io). Apache 2.0.
`,
);

run("npm", ["pack", "--pack-destination", out], out);
process.stdout.write(`\nPacked ${NAME}@${rootPkg.version} into ${out}\n`);
