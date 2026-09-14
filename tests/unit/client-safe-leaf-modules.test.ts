import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Guards the client/server import boundary for the modules that "use client"
// React components reach, plus the two dependency-leaf modules that exist solely
// so those components can import a pure value without dragging the server
// runtime into the browser bundle:
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
// WHAT THIS TEST IS
//
// It enforces an architectural policy -- these modules stay reachable from the
// browser bundle -- across the import edges its resolver can follow. It does NOT
// reimplement the bundler and does not claim to predict build success.
//
// WHAT THAT SCOPE COSTS
//
// Resolution completeness and denylist breadth are INDEPENDENT properties, and
// the guard needs both. Banning shimmed builtins like `path` is defensible as
// explicit policy (see BARE_NODE_BUILTINS), but widening the denylist buys
// nothing against an edge the resolver never followed: a module dropped from the
// walk is invisible no matter how strict the rules applied to the modules that
// remain. Three concrete escapes of that shape have been demonstrated against
// earlier versions of this file -- an import through a path alias the resolver
// did not know about, an import whose `?resource-suffix` made it look external,
// and `import "ioredis?review"`, where the resolver stripped the suffix but the
// denylist compared the raw string, so the two disagreed and webpack pulled in
// the real ioredis while this test stayed green. Hence, in addition to the
// denylists:
//
//   * path aliases are read from tsconfig.json (loadPathAliases) rather than
//     hardcoded, so adding an alias cannot silently shrink the graph;
//   * `?query` / `#fragment` resource suffixes are normalized away at exactly
//     one point (classifySpecifier), so resolution and the denylist always
//     judge the same string;
//   * a relative or aliased specifier that fails to resolve is itself a
//     FAILURE, not a silently dropped edge;
//   * a dynamic import whose argument is not a static string is a FAILURE,
//     because the bundler resolves it by context and can pull in a directory.
//
// Parsing uses the installed TypeScript compiler (a devDependency) rather than
// regexes. Regexes got this wrong in both directions: they missed
// `import(`node:fs`)` written with a template literal, and they flagged
// `import type { Stats } from "node:fs"`, which the compiler erases entirely and
// which the bundler therefore never sees. open-sse/services/sessionPool has a
// real type-only `node:events` import, so that false positive is not theoretical.
//
// Nothing here imports the modules under test: a runtime import proves nothing
// about the bundler's static graph and would run module side effects.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface ClientEntry {
  /** Repo-relative entry module whose whole static graph must stay client-safe. */
  readonly path: string;
  /** Why this file is on the client side of the boundary. */
  readonly reason: string;
  /**
   * Repo-relative module this entry must keep importing DIRECTLY, or null.
   * The graph walk proves nothing was added; this proves the cheap leaf import
   * was not quietly swapped back for the server-heavy original.
   */
  readonly mustImportDirectly: string | null;
}

const CLIENT_ENTRIES: readonly ClientEntry[] = [
  {
    path: "open-sse/services/providerAlias.ts",
    reason: 'dependency leaf for "use client" components that need alias resolution',
    mustImportDirectly: null,
  },
  {
    path: "open-sse/utils/cursorAgentCliVersionPin.ts",
    reason: 'dependency leaf for "use client" components that need the CLI version pin',
    mustImportDirectly: null,
  },
  {
    path: "src/lib/combos/controlCenter.ts",
    reason: 'imported by the "use client" ComboControlCenterClient',
    mustImportDirectly: "open-sse/services/providerAlias.ts",
  },
  {
    path: "src/lib/oauth/constants/oauth.ts",
    reason: 'reachable from the "use client" CliAgentsPageClient via cliTools -> providerRegistry',
    mustImportDirectly: "open-sse/utils/cursorAgentCliVersionPin.ts",
  },
];

/**
 * Every node builtin importable as a bare specifier, derived from the running
 * Node rather than hand-curated. All of them are forbidden here.
 *
 * This is deliberately stricter than the bundler, as policy rather than as
 * build-failure prediction. Next 16.3.3 ships browserify shims for 22 of these
 * on the client target -- assert, buffer, constants, crypto, domain, http,
 * https, os, path, punycode, process, querystring, stream, string_decoder, sys,
 * timers, tty, url, util, vm, zlib, events, setImmediate
 * (node_modules/next/dist/build/webpack-config.js resolve.fallback, the same
 * table compiled into the Turbopack binary, plus `url` via
 * create-compiler-aliases.js getOptimizedModuleAliases) -- so importing those
 * resolves rather than failing the build today. They are still banned:
 *
 *   1. The shims are one config flag from disappearing: setting
 *      `experimental.fallbackNodePolyfills: false` replaces every entry above
 *      with `false`.
 *   2. A shim is not correctness. `os-browserify` returns stub values; code that
 *      reaches for `os` in the browser is already wrong, it just fails silently
 *      instead of loudly.
 *
 * No client-reachable module currently imports any builtin, so the strict rule
 * costs nothing. If one ever legitimately needs `buffer`, this fails loudly and
 * the exception gets written down instead of being assumed.
 *
 * Entries that `builtinModules` lists WITH the `node:` prefix (node:sqlite,
 * node:test, ...) are prefix-only and cannot be imported bare, so they are left
 * out of this set; the unconditional `node:` rule below already covers them.
 */
const BARE_NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("node:")));

/**
 * Bare packages that only exist server-side (native addons, redis, browsers).
 * Curated on purpose: this is about THIS repo's server dependencies, not about
 * the bundler. `server-only` is Next's own marker -- it resolves to a module
 * whose body is `throw new Error(...)` in the client layer
 * (node_modules/next/dist/compiled/server-only/index.js).
 */
const FORBIDDEN_PACKAGES = new Set([
  "ioredis",
  "better-sqlite3",
  "sqlite-vec",
  "keytar",
  "playwright",
  "server-only",
]);

/** Repo directories that are server-only by construction. */
const FORBIDDEN_DIRS = ["src/lib/db/"];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"];

/** One `compilerOptions.paths` entry, normalized for prefix matching. */
interface PathAlias {
  /** The pattern as written, for failure messages. */
  readonly pattern: string;
  /** Match text: the full pattern, or everything before `*` for a wildcard. */
  readonly prefix: string;
  readonly wildcard: boolean;
  /** Target directories/files, repo-relative, `/*` suffix already removed. */
  readonly targets: readonly string[];
}

/**
 * Path aliases read from tsconfig.json `compilerOptions.paths`.
 *
 * Derived rather than hardcoded so that adding an alias cannot silently remove
 * a subtree from the walk -- `@omniroute/browser-pool` (which reaches playwright
 * and node:buffer) escaped an earlier hardcoded version of this resolver exactly
 * that way. The repo sets no `baseUrl`, so targets resolve relative to the
 * tsconfig directory, which is the repo root.
 *
 * Sorted longest-prefix-first so `@omniroute/open-sse/*` wins over
 * `@omniroute/open-sse` for a subpath specifier.
 */
function loadPathAliases(): readonly PathAlias[] {
  const configPath = resolve(repoRoot, "tsconfig.json");
  const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8"));
  assert.equal(parsed.error, undefined, `tsconfig.json did not parse: ${String(parsed.error)}`);
  const config: unknown = parsed.config;
  const paths =
    typeof config === "object" && config !== null && "compilerOptions" in config
      ? (config as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions
          ?.paths
      : undefined;
  const aliases: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(paths ?? {})) {
    const wildcard = pattern.endsWith("/*");
    aliases.push({
      pattern,
      prefix: wildcard ? pattern.slice(0, -1) : pattern,
      wildcard,
      targets: targets.map((target) => target.replace(/\/\*$/, "")),
    });
  }
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

const PATH_ALIASES = loadPathAliases();

/** How a specifier reached the graph, for the failure message. */
type RefKind = "import" | "side-effect import" | "re-export" | "dynamic import" | "require";

interface ModuleRef {
  readonly specifier: string;
  readonly kind: RefKind;
}

/**
 * A dynamic `import()` or `require()` whose argument is not a static string.
 * The bundler cannot resolve it either, so it falls back to context resolution
 * and can pull an entire directory into the client chunk.
 */
interface UnresolvableRef {
  readonly text: string;
  readonly kind: RefKind;
}

interface FileRefs {
  readonly refs: readonly ModuleRef[];
  readonly unresolvable: readonly UnresolvableRef[];
}

/** The text of a specifier node, or null when it is not a static string. */
function staticText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * True when every named binding carries its own `type` marker, so the compiler
 * erases the whole declaration. An empty list (`import {} from "x"`,
 * `export {} from "x"`) still creates a runtime edge and must not count as
 * erased, hence the length check.
 */
function allBindingsTypeOnly(
  elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]
): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

/**
 * True when the whole import is erased before the bundler sees it: `import type
 * ...`, or a named import whose every binding is marked `type`. A default or
 * namespace binding keeps the import alive.
 */
function isErasedImport(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (clause.name !== undefined || bindings === undefined || !ts.isNamedImports(bindings)) {
    return false;
  }
  return allBindingsTypeOnly(bindings.elements);
}

/**
 * True when the whole re-export is erased: `export type { ... } from "x"`, or
 * `export { type A, type B } from "x"` where every specifier is type-marked --
 * tsc emits a bare `export {};` for both, so no runtime edge exists.
 * `export * from "x"` is never erased.
 */
function isErasedExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return false;
  return allBindingsTypeOnly(clause.elements);
}

/**
 * Every module specifier a bundler would see in one file: static
 * `import`/`export ... from`, bare side-effect `import "x"`, dynamic
 * `import("x")` and `require("x")`. Dynamic imports count -- webpack still
 * resolves them to split the chunk.
 *
 * `import("x")` in a TYPE position (`type B = import("playwright").Browser`) is
 * an ImportTypeNode, not a CallExpression, so it is correctly not collected;
 * packages/browser-pool uses that form and it carries no runtime edge.
 */
function collectRefs(file: string): FileRefs {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const refs: ModuleRef[] = [];
  const unresolvable: UnresolvableRef[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!isErasedImport(node.importClause)) {
        const specifier = staticText(node.moduleSpecifier);
        if (specifier !== null) {
          refs.push({
            specifier,
            kind: node.importClause === undefined ? "side-effect import" : "import",
          });
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (!isErasedExport(node)) {
        const specifier = staticText(node.moduleSpecifier);
        if (specifier !== null) refs.push({ specifier, kind: "re-export" });
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const kind: RefKind = isDynamicImport ? "dynamic import" : "require";
        const argument = node.arguments[0];
        const specifier = staticText(argument);
        if (specifier !== null) refs.push({ specifier, kind });
        else unresolvable.push({ text: argument.getText().slice(0, 80), kind });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return { refs, unresolvable };
}

function toRepoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).split("\\").join("/");
}

function isFile(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isFile();
}

/**
 * True when an absolute path lies inside the repository. Uses `relative` rather
 * than a string prefix so a sibling directory (`/…/omniroute-fork-backup`) is
 * not mistaken for a child of `/…/omniroute-fork`.
 */
function isUnderRepoRoot(absolutePath: string): boolean {
  const rel = relative(repoRoot, absolutePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The specifier as the bundler's resolver sees it: a webpack/Turbopack resource
 * suffix (`./x.ts?raw`, `ioredis?review`, `x#frag`) is metadata for loaders, not
 * part of the module request, so it is cut here. A leading `#` is a Node subpath
 * import rather than a fragment, so only a suffix at index > 0 is cut.
 *
 * Applied at exactly ONE call site (classifySpecifier). An earlier version
 * normalized inside the resolver only, so `import "ioredis?review"` resolved to
 * ioredis while the denylist compared against the raw string and saw no match --
 * webpack happily pulled the real ioredis in (failing on net/tls/path inside
 * ioredis/built/) while this test stayed green. Resolution and classification
 * must read the same string or that divergence just comes back in a new shape.
 */
function normalizeSpecifier(specifier: string): string {
  const cut = specifier.search(/[?#]/);
  return cut > 0 ? specifier.slice(0, cut) : specifier;
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

/**
 * What a specifier points at. `internal` means the specifier is relative or
 * matched a tsconfig alias, so it MUST land on a repo file -- failing to find
 * one is a hole in this resolver and is reported rather than dropped.
 */
type Resolution =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "unresolved-internal"; readonly detail: string }
  | { readonly kind: "external" };

/** Takes an ALREADY-normalized specifier; call it through classifySpecifier. */
function resolveSpecifier(specifier: string, fromFile: string): Resolution {
  if (specifier.startsWith(".")) {
    const hit = resolveFromBase(resolve(dirname(fromFile), specifier));
    return hit !== null
      ? { kind: "file", path: hit }
      : { kind: "unresolved-internal", detail: "relative specifier" };
  }
  if (isAbsolute(specifier)) {
    // An absolute path INSIDE the repo is an internal edge, not an external
    // package: webpack resolves it to that very file. Declaring every absolute
    // specifier external let `import "<repoRoot>/src/lib/db/core.ts"` walk
    // straight into the server-only directory unchecked.
    if (!isUnderRepoRoot(specifier)) return { kind: "external" };
    const hit = resolveFromBase(specifier);
    return hit !== null
      ? { kind: "file", path: hit }
      : { kind: "unresolved-internal", detail: "absolute path inside the repository" };
  }
  for (const alias of PATH_ALIASES) {
    const matches = alias.wildcard
      ? specifier.startsWith(alias.prefix)
      : specifier === alias.prefix;
    if (!matches) continue;
    const rest = alias.wildcard ? specifier.slice(alias.prefix.length) : "";
    for (const target of alias.targets) {
      const hit = resolveFromBase(resolve(repoRoot, target, rest));
      if (hit !== null) return { kind: "file", path: hit };
    }
    return {
      kind: "unresolved-internal",
      detail: `tsconfig alias "${alias.pattern}" -> ${alias.targets.join(", ")}`,
    };
  }
  return { kind: "external" };
}

/**
 * Why this specifier is forbidden, or null if it is fine. Bare packages that are
 * merely client-irrelevant (react, zod) are allowed -- only the server-only ones
 * listed above fail.
 */
function forbiddenReason(specifier: string, resolvedPath: string | null): string | null {
  if (specifier.startsWith("node:")) {
    // Verified against Next 16.3.3's own webpack: every `node:` specifier fails
    // a target:"web" build with UnhandledSchemeError, including `node:path`,
    // whose bare form resolves to path-browserify.
    return `imports the node: scheme module "${specifier}"`;
  }
  if (!specifier.startsWith(".") && !specifier.startsWith("@") && !specifier.startsWith("/")) {
    const head = specifier.split("/")[0];
    // Builtins match case-SENSITIVELY, unlike the packages below. Node resolves
    // builtin names exactly and webpack's resolve.fallback keys are exact, so
    // `FS` never reaches the builtin on any platform -- require.resolve("FS")
    // throws MODULE_NOT_FOUND even on this case-insensitive filesystem. Folding
    // case here would therefore guard nothing while newly rejecting any real
    // package whose name differs from a builtin only by case.
    if (BARE_NODE_BUILTINS.has(head)) {
      return `imports the node builtin "${specifier}"`;
    }
    // Packages match case-INSENSITIVELY. npm package names are lowercase by
    // spec, but a case-insensitive filesystem (macOS APFS, Windows) resolves
    // `import "IOREDIS"` to node_modules/ioredis all the same -- verified here:
    // require.resolve("IOREDIS") lands on ioredis/built/index.js. Still an exact
    // name match, not a prefix one, so `ioredis-mock` stays allowed.
    if (FORBIDDEN_PACKAGES.has(head.toLowerCase())) {
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

interface Classification {
  /** The normalized specifier both the resolver and the denylist judged. */
  readonly specifier: string;
  readonly resolution: Resolution;
  /** Non-null when the specifier is forbidden outright. */
  readonly reason: string | null;
}

/**
 * The single place a raw specifier is turned into a verdict: normalize once,
 * then resolve and classify the SAME string. Every caller goes through here so
 * the resolver and the denylist can never disagree about what was imported.
 */
function classifySpecifier(rawSpecifier: string, fromFile: string): Classification {
  const specifier = normalizeSpecifier(rawSpecifier);
  const resolution = resolveSpecifier(specifier, fromFile);
  const resolvedPath = resolution.kind === "file" ? resolution.path : null;
  return { specifier, resolution, reason: forbiddenReason(specifier, resolvedPath) };
}

interface Violation {
  readonly file: string;
  readonly reason: string;
  readonly chain: readonly string[];
}

interface GraphResult {
  readonly violations: readonly Violation[];
  /** Repo-relative paths of every module the entry imports directly. */
  readonly directImports: ReadonlySet<string>;
  readonly moduleCount: number;
}

/**
 * Breadth-first walk of the static import graph from `entry`. The `parent` map
 * doubles as the seen-set, so import cycles terminate, and it lets a violation
 * report the exact chain that reached the offending file.
 */
function walkGraph(entry: string): GraphResult {
  const entryPath = resolve(repoRoot, entry);
  assert.ok(isFile(entryPath), `client entry is missing: ${entry}`);

  const parent = new Map<string, string | null>([[entryPath, null]]);
  const queue: string[] = [entryPath];
  const violations: Violation[] = [];
  const directImports = new Set<string>();

  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    let cursor: string | null = file;
    while (cursor !== null) {
      chain.unshift(toRepoPath(cursor));
      cursor = parent.get(cursor) ?? null;
    }
    return chain;
  };

  const report = (file: string, reason: string): void => {
    violations.push({ file: toRepoPath(file), reason, chain: chainTo(file) });
  };

  while (queue.length > 0) {
    const file = queue.shift() as string;
    const { refs, unresolvable } = collectRefs(file);
    for (const { text, kind } of unresolvable) {
      report(
        file,
        `has a ${kind} the bundler cannot resolve statically (\`${text}\`); webpack falls back to context resolution and can pull a whole directory into the client chunk`
      );
    }
    for (const { specifier: rawSpecifier, kind } of refs) {
      const { specifier, resolution, reason } = classifySpecifier(rawSpecifier, file);
      // Quote the source text too when a resource suffix was cut, so the report
      // names what was actually written, not just what it normalized to.
      const asWritten = specifier === rawSpecifier ? kind : `${kind}, written as "${rawSpecifier}"`;
      if (resolution.kind === "unresolved-internal") {
        // Never drop this edge silently: an unwalked module is unpoliced, which
        // is how aliased and `?suffix`-ed imports escaped earlier versions.
        report(
          file,
          `${kind}s "${rawSpecifier}" (${resolution.detail}), which this test cannot resolve to a repo file, so its import graph would go unchecked. Teach resolveSpecifier about it or fix the specifier`
        );
        continue;
      }
      const resolvedPath = resolution.kind === "file" ? resolution.path : null;
      if (resolvedPath !== null && file === entryPath) directImports.add(toRepoPath(resolvedPath));
      if (reason !== null) {
        report(file, `${reason} (${asWritten})`);
        continue;
      }
      if (resolvedPath !== null && !parent.has(resolvedPath)) {
        parent.set(resolvedPath, file);
        queue.push(resolvedPath);
      }
    }
  }

  return { violations, directImports, moduleCount: parent.size };
}

function formatViolations(entry: ClientEntry, violations: readonly Violation[]): string {
  const lines = [
    `${entry.path} must stay safe for the browser bundle (${entry.reason}), but its static import graph reaches server-only code:`,
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

// Guard the guard: if tsconfig parsing ever yields nothing, every aliased import
// silently becomes "external" and the walk collapses to relative edges only --
// a catastrophic, invisible weakening of every test below.
test("path aliases are loaded from tsconfig.json, so aliased imports stay in the walk", () => {
  assert.ok(PATH_ALIASES.length > 0, "no compilerOptions.paths loaded from tsconfig.json");
  const patterns = new Set(PATH_ALIASES.map((alias) => alias.pattern));
  for (const expected of ["@/*", "@omniroute/open-sse", "@omniroute/open-sse/*"]) {
    assert.ok(
      patterns.has(expected),
      `tsconfig.json compilerOptions.paths must still define "${expected}"; found: ${[...patterns].join(", ")}`
    );
  }
});

// A resource suffix must never smuggle a specifier past the denylist. This goes
// through classifySpecifier -- the real call path walkGraph uses -- rather than
// poking the helpers, so it fails if normalization is ever split back apart.
test("resource suffixes cannot hide a forbidden specifier from the denylist", () => {
  const fromFile = resolve(repoRoot, "open-sse/utils/cursorAgentCliVersionPin.ts");

  // Suffixed forms of both denylist halves, plus the node: scheme.
  for (const [raw, expected] of [
    ["ioredis?review", "ioredis"],
    ["ioredis#frag", "ioredis"],
    ["better-sqlite3?x=1", "better-sqlite3"],
    ["fs?review", "fs"],
    ["fs#frag", "fs"],
    ["diagnostics_channel?x", "diagnostics_channel"],
    ["node:fs?review", "node:fs"],
  ] as const) {
    const { specifier, reason } = classifySpecifier(raw, fromFile);
    assert.equal(specifier, expected, `"${raw}" must normalize to "${expected}"`);
    assert.notEqual(
      reason,
      null,
      `"${raw}" must be rejected; webpack strips the suffix and resolves it like "${expected}"`
    );
  }

  // Case variants of a forbidden PACKAGE. A case-insensitive filesystem (macOS
  // APFS, Windows) resolves these to node_modules/ioredis, so the denylist has
  // to fold case even though npm names are lowercase by spec.
  for (const raw of ["IOREDIS", "IoRedis", "Playwright", "IOREDIS?review"]) {
    assert.notEqual(
      classifySpecifier(raw, fromFile).reason,
      null,
      `"${raw}" must be rejected; a case-insensitive filesystem resolves it to the real package`
    );
  }

  // Controls: the denylist must stay an exact name match, not a prefix one...
  assert.equal(classifySpecifier("ioredis-mock", fromFile).reason, null);
  assert.equal(classifySpecifier("react?x", fromFile).reason, null);
  // ...case folding must not spread to builtins, which never resolve by a
  // different case (require.resolve("FS") throws even on APFS)...
  assert.equal(classifySpecifier("FS", fromFile).reason, null);
  // ...and a leading "#" is a Node subpath import, not a fragment to cut.
  assert.equal(classifySpecifier("#internal/foo", fromFile).specifier, "#internal/foo");
});

// An absolute specifier pointing into this repo is an internal edge: webpack
// resolves it to that exact file. Classifying every absolute path as "external"
// let an absolute import walk into src/lib/db/ without ever being looked at.
test("absolute specifiers inside the repository are followed, not treated as external", () => {
  const fromFile = resolve(repoRoot, "open-sse/utils/cursorAgentCliVersionPin.ts");

  const insideForbidden = resolve(repoRoot, "src/lib/db/core.ts");
  const inside = classifySpecifier(insideForbidden, fromFile);
  assert.equal(inside.resolution.kind, "file", "an absolute path in the repo must resolve");
  assert.notEqual(
    inside.reason,
    null,
    `${insideForbidden} resolves into the server-only directory and must be rejected`
  );

  // A repo file that is NOT forbidden still resolves, so the walk follows it.
  const insideAllowed = classifySpecifier(
    resolve(repoRoot, "open-sse/services/providerAlias.ts"),
    fromFile
  );
  assert.equal(insideAllowed.resolution.kind, "file");
  assert.equal(insideAllowed.reason, null);

  // Genuinely external absolute paths stay external -- including a sibling
  // directory whose path merely shares the repo root as a string prefix.
  for (const outside of [
    "/usr/lib/node_modules/whatever.js",
    `${repoRoot}-backup/src/lib/db/core.ts`,
  ]) {
    assert.equal(
      classifySpecifier(outside, fromFile).resolution.kind,
      "external",
      `${outside} is outside the repository and must stay external`
    );
  }
});

for (const entry of CLIENT_ENTRIES) {
  test(`${entry.path} import graph never reaches server-only modules`, () => {
    const { violations } = walkGraph(entry.path);
    assert.equal(violations.length, 0, formatViolations(entry, violations));
  });

  const required = entry.mustImportDirectly;
  if (required !== null) {
    test(`${entry.path} still imports ${required} directly`, () => {
      const { directImports } = walkGraph(entry.path);
      assert.ok(
        directImports.has(required),
        `${entry.path} must import ${required} directly (${entry.reason}).\n` +
          "It no longer does, which usually means the import was swapped back for the server-heavy original.\n" +
          `Direct repo imports found: ${[...directImports].sort().join(", ") || "(none)"}`
      );
    });
  }
}
