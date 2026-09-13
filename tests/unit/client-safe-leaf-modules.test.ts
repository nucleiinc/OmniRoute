import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Guards the client/server boundary for two dependency-leaf modules that exist
// solely so "use client" React components can import a pure value without
// dragging the server runtime into the browser bundle:
//
//   open-sse/services/providerAlias.ts          ALIAS_TO_PROVIDER_ID / resolveProviderAlias
//   open-sse/utils/cursorAgentCliVersionPin.ts  CURSOR_AGENT_CLI_VERSION
//
// Their heavy originals (services/model.ts reaching ioredis/sqlite via the
// settings -> usage -> rateLimiter chain, utils/cursorAgentCliVersion.ts
// importing node:fs/os/path) broke the production build with
// UnhandledSchemeError and unresolvable `dns`/`net`. Typecheck cannot see this
// class of regression, and `next build` only surfaces it after a multi-minute
// failure that is hard to attribute.
//
// So walk the static import graph of each leaf the way a bundler would -- by
// reading source text, never by importing the module (a runtime import proves
// nothing about the bundler's static graph and would run module side effects)
// -- and fail if any reachable file pulls in a server-only dependency.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Leaf modules that must stay safe to import from a "use client" component. */
const CLIENT_SAFE_LEAVES = [
  "open-sse/services/providerAlias.ts",
  "open-sse/utils/cursorAgentCliVersionPin.ts",
];

/** Bare builtins that must never appear, with or without a `node:` scheme. */
const FORBIDDEN_BUILTINS = new Set([
  "fs",
  "path",
  "os",
  "net",
  "dns",
  "tls",
  "http2",
  "child_process",
  "async_hooks",
  "inspector",
  "readline",
  "module",
]);

/** Bare packages that only exist server-side (native addons, redis, browsers). */
const FORBIDDEN_PACKAGES = new Set([
  "ioredis",
  "better-sqlite3",
  "sqlite-vec",
  "keytar",
  "playwright",
]);

/** Repo directories that are server-only by construction. */
const FORBIDDEN_DIRS = ["src/lib/db/"];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"];

/**
 * Remove comments so a `// import Redis from "ioredis"` note in a doc block
 * cannot be mistaken for a real import. Tracks string and template state so a
 * `"https://..."` literal is not treated as the start of a line comment.
 */
function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      if (ch === "\\") {
        out += ch + (next ?? "");
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Every module specifier a bundler would see: static `import`/`export ... from`,
 * bare side-effect `import "x"`, dynamic `import("x")` and `require("x")`.
 * Dynamic imports count -- webpack still resolves them for the client bundle.
 */
function extractSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|[\n;}])\s*(?:import|export)(?:\s+type)?\s*(?:[^"'();]*?\sfrom\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(code);
    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(code);
    }
  }
  return specifiers;
}

/**
 * Why this specifier is forbidden, or null if it is fine. Bare packages that are
 * merely client-irrelevant (react, zod) are allowed -- only the server-only ones
 * listed above fail.
 */
function forbiddenReason(specifier: string, resolvedPath: string | null): string | null {
  if (specifier.startsWith("node:")) {
    return `imports the node: scheme module "${specifier}"`;
  }
  if (!specifier.startsWith(".") && !specifier.startsWith("@") && !specifier.startsWith("/")) {
    const head = specifier.split("/")[0];
    if (FORBIDDEN_BUILTINS.has(head)) {
      return `imports the node builtin "${specifier}"`;
    }
    if (FORBIDDEN_PACKAGES.has(head)) {
      return `imports the server-only package "${specifier}"`;
    }
  }
  if (resolvedPath !== null) {
    const rel = toRepoPath(resolvedPath);
    for (const dir of FORBIDDEN_DIRS) {
      if (rel.startsWith(dir)) {
        return `imports "${specifier}", which resolves into the server-only directory ${dir}`;
      }
    }
  }
  return null;
}

function toRepoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).split("\\").join("/");
}

function isFile(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isFile();
}

/** First on-disk file for a base path, mirroring TS/bundler extension probing. */
function resolveFromBase(base: string): string | null {
  if (isFile(base)) return base;
  // A `.js` specifier in TS source normally means the sibling `.ts` file.
  const jsMatch = /\.(js|mjs|jsx)$/.exec(base);
  if (jsMatch !== null) {
    const stem = base.slice(0, -jsMatch[0].length);
    for (const ext of SOURCE_EXTENSIONS) {
      if (isFile(stem + ext)) return stem + ext;
    }
  }
  for (const ext of SOURCE_EXTENSIONS) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const indexFile = resolve(base, `index${ext}`);
    if (isFile(indexFile)) return indexFile;
  }
  return null;
}

/** Resolve a specifier to a repo file, or null when it is an external package. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith(".")) {
    return resolveFromBase(resolve(dirname(fromFile), specifier));
  }
  if (specifier.startsWith("@/")) {
    return resolveFromBase(resolve(repoRoot, "src", specifier.slice(2)));
  }
  if (specifier === "@omniroute/open-sse") {
    return resolveFromBase(resolve(repoRoot, "open-sse"));
  }
  const openSsePrefix = "@omniroute/open-sse/";
  if (specifier.startsWith(openSsePrefix)) {
    return resolveFromBase(resolve(repoRoot, "open-sse", specifier.slice(openSsePrefix.length)));
  }
  return null;
}

interface Violation {
  file: string;
  reason: string;
  chain: string[];
}

/**
 * Breadth-first walk of the static import graph from `entry`. The `parent` map
 * doubles as the seen-set, so import cycles terminate, and it lets a violation
 * report the exact chain that reached the offending file.
 */
function findViolations(entry: string): Violation[] {
  const entryPath = resolve(repoRoot, entry);
  assert.ok(isFile(entryPath), `leaf module is missing: ${entry}`);

  const parent = new Map<string, string | null>([[entryPath, null]]);
  const queue: string[] = [entryPath];
  const violations: Violation[] = [];

  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    let cursor: string | null = file;
    while (cursor !== null) {
      chain.unshift(toRepoPath(cursor));
      cursor = parent.get(cursor) ?? null;
    }
    return chain;
  };

  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const specifier of extractSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(specifier, file);
      const reason = forbiddenReason(specifier, resolved);
      if (reason !== null) {
        violations.push({ file: toRepoPath(file), reason, chain: chainTo(file) });
        continue;
      }
      if (resolved !== null && !parent.has(resolved)) {
        parent.set(resolved, file);
        queue.push(resolved);
      }
    }
  }

  return violations;
}

function formatViolations(entry: string, violations: Violation[]): string {
  const lines = [
    `${entry} must stay safe to import from a "use client" component, but its static import graph reaches server-only code:`,
    "",
  ];
  for (const violation of violations) {
    lines.push(`  ${violation.file} ${violation.reason}`);
    lines.push(`    reached via: ${violation.chain.join(" -> ")}`);
    lines.push("");
  }
  lines.push(
    "Move the offending code behind a dependency leaf (or import the pure value from one) instead of widening this list."
  );
  return lines.join("\n");
}

for (const leaf of CLIENT_SAFE_LEAVES) {
  test(`${leaf} import graph never reaches server-only modules`, () => {
    const violations = findViolations(leaf);
    assert.equal(violations.length, 0, formatViolations(leaf, violations));
  });
}

test("client-reachable consumers import the leaf modules, not the server-heavy originals", () => {
  const controlCenter = stripComments(
    readFileSync(resolve(repoRoot, "src/lib/combos/controlCenter.ts"), "utf8")
  );
  assert.match(
    controlCenter,
    /import\s*\{[^}]*\bresolveProviderAlias\b[^}]*\}\s*from\s*["'][^"']*\/providerAlias(?:\.ts)?["']/,
    'src/lib/combos/controlCenter.ts must import resolveProviderAlias from open-sse/services/providerAlias.ts; services/model.ts reaches ioredis and breaks the "use client" ComboControlCenterClient bundle'
  );
  assert.doesNotMatch(
    controlCenter,
    /from\s*["'][^"']*services\/model(?:\.ts)?["']/,
    "src/lib/combos/controlCenter.ts must not import from open-sse/services/model.ts"
  );

  const oauth = stripComments(
    readFileSync(resolve(repoRoot, "src/lib/oauth/constants/oauth.ts"), "utf8")
  );
  assert.match(
    oauth,
    /import\s*\{[^}]*\bCURSOR_AGENT_CLI_VERSION\b[^}]*\}\s*from\s*["'][^"']*\/cursorAgentCliVersionPin(?:\.ts)?["']/,
    'src/lib/oauth/constants/oauth.ts must import CURSOR_AGENT_CLI_VERSION from open-sse/utils/cursorAgentCliVersionPin.ts; cursorAgentCliVersion.ts imports node:fs/os/path and breaks the "use client" CliAgentsPageClient bundle'
  );
  assert.doesNotMatch(
    oauth,
    /from\s*["'][^"']*\/cursorAgentCliVersion(?:\.ts)?["']/,
    "src/lib/oauth/constants/oauth.ts must not import from open-sse/utils/cursorAgentCliVersion.ts"
  );
});
