import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error — plain .mjs gate, no types
import {
  collectProblems,
  diffOverrides,
  expectedPnpmOverrides,
  findDeviationProblems,
  findUnmappableKeys,
  findUnsupportedValues,
  flattenNpmOverrides,
} from "../../scripts/check/check-pnpm-overrides-sync.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const gatePath = path.join(repoRoot, "scripts/check/check-pnpm-overrides-sync.mjs");

// Two npm keys sharing one pnpm target, mirroring the real DEVIATIONS shape.
const COLLAPSING = {
  "libxmljs2>minimatch>brace-expansion": {
    target: "minimatch@9>brace-expansion",
    reason: "test fixture",
  },
  "rimraf>minimatch>brace-expansion": {
    target: "minimatch@9>brace-expansion",
    reason: "test fixture",
  },
};

// --- flattening npm's nested form into pnpm selectors ---

test("flattenNpmOverrides keeps flat entries unchanged", () => {
  assert.deepEqual(
    { ...flattenNpmOverrides({ qs: "^6.16.0", tar: "^7.5.21" }) },
    {
      qs: "^6.16.0",
      tar: "^7.5.21",
    }
  );
});

test("flattenNpmOverrides converts npm's nested form to pnpm's > selector", () => {
  assert.deepEqual(
    { ...flattenNpmOverrides({ jsdom: { undici: "^7.29.0" } }) },
    {
      "jsdom>undici": "^7.29.0",
    }
  );
});

test("flattenNpmOverrides expands a parent pinning several children", () => {
  assert.deepEqual(
    { ...flattenNpmOverrides({ promptfoo: { "js-yaml": "^5.2.2", undici: "^7.29.0" } }) },
    {
      "promptfoo>js-yaml": "^5.2.2",
      "promptfoo>undici": "^7.29.0",
    }
  );
});

test("flattenNpmOverrides walks deep nesting (flattener only; the gate rejects this shape)", () => {
  assert.deepEqual(
    { ...flattenNpmOverrides({ libxmljs2: { minimatch: { "brace-expansion": "^2.1.4" } } }) },
    { "libxmljs2>minimatch>brace-expansion": "^2.1.4" }
  );
});

// --- deviations ---

test("expectedPnpmOverrides rewrites a key through its declared deviation", () => {
  const { expected, conflicts } = expectedPnpmOverrides(
    { "libxmljs2>minimatch>brace-expansion": "^2.1.4" },
    COLLAPSING
  );
  assert.deepEqual({ ...expected }, { "minimatch@9>brace-expansion": "^2.1.4" });
  assert.deepEqual(conflicts, []);
});

test("expectedPnpmOverrides collapses two npm keys that agree on a value", () => {
  const { expected, conflicts } = expectedPnpmOverrides(
    {
      "libxmljs2>minimatch>brace-expansion": "^2.1.4",
      "rimraf>minimatch>brace-expansion": "^2.1.4",
    },
    COLLAPSING
  );
  assert.deepEqual({ ...expected }, { "minimatch@9>brace-expansion": "^2.1.4" });
  assert.deepEqual(conflicts, []);
});

// The regression that mattered: before conflict detection the collapse kept whichever
// npm key was written last, so an upstream bump to the other one passed the gate
// silently, and which key won depended on ordering in a file upstream controls.
test("expectedPnpmOverrides reports a conflict when collapsing keys DISAGREE", () => {
  const { conflicts } = expectedPnpmOverrides(
    {
      "libxmljs2>minimatch>brace-expansion": "^2.9.9",
      "rimraf>minimatch>brace-expansion": "^2.1.4",
    },
    COLLAPSING
  );
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /DIFFERENT values/);
  assert.match(conflicts[0], /\^2\.9\.9/);
});

test("a disagreeing collapse fails the gate regardless of npm key order", () => {
  const bumpFirst = collectProblems(
    {
      libxmljs2: { minimatch: { "brace-expansion": "^2.9.9" } },
      rimraf: { minimatch: { "brace-expansion": "^2.1.4" } },
    },
    { "minimatch@9>brace-expansion": "^2.1.4" },
    COLLAPSING,
    {}
  );
  const bumpSecond = collectProblems(
    {
      rimraf: { minimatch: { "brace-expansion": "^2.1.4" } },
      libxmljs2: { minimatch: { "brace-expansion": "^2.9.9" } },
    },
    { "minimatch@9>brace-expansion": "^2.1.4" },
    COLLAPSING,
    {}
  );
  assert.ok(bumpFirst.length > 0, "bump listed first must fail");
  assert.ok(bumpSecond.length > 0, "bump listed second must fail too");
});

// --- depth: selectors pnpm silently ignores ---

test("findUnmappableKeys flags a key with more than one > level", () => {
  const problems = findUnmappableKeys({ "foo>bar>baz": "^1.0.0", "jsdom>undici": "^7.0.0" });
  assert.equal(problems.length, 1, "only the deeper key is unmappable");
  assert.match(problems[0], /"foo>bar>baz" has 2 ">" levels/);
});

test("findUnmappableKeys accepts a version-ranged parent, which is still one level", () => {
  assert.deepEqual(findUnmappableKeys({ "minimatch@9>brace-expansion": "^2.1.4" }), []);
});

// Mirroring a 3-level key verbatim looks synced, but pnpm ignores the selector so the
// pin does nothing. Presence in the YAML must not count as enforcement.
test("a doubly-nested pin with no deviation fails even when mirrored verbatim", () => {
  const problems = collectProblems(
    { foo: { bar: { baz: "^1.0.0" } } },
    { "foo>bar>baz": "^1.0.0" },
    {},
    {}
  );
  assert.ok(problems.some((p: string) => /">" levels/.test(p)));
});

// --- stale and malformed deviations (repo convention: scripts/check/lib/allowlist.mjs) ---

test("findDeviationProblems flags a deviation whose npm key upstream dropped", () => {
  const problems = findDeviationProblems(
    { "rimraf>minimatch>brace-expansion": "^2.1.4" },
    COLLAPSING
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /stale DEVIATIONS entry "libxmljs2>minimatch>brace-expansion"/);
});

test("findDeviationProblems flags a deviation with no reason", () => {
  const problems = findDeviationProblems({ "a>b>c": "^1.0.0" }, { "a>b>c": { target: "b>c" } });
  assert.ok(problems.some((p: string) => /has no reason/.test(p)));
});

test("findDeviationProblems is silent when every deviation is live and justified", () => {
  assert.deepEqual(
    findDeviationProblems(
      {
        "libxmljs2>minimatch>brace-expansion": "^2.1.4",
        "rimraf>minimatch>brace-expansion": "^2.1.4",
      },
      COLLAPSING
    ),
    []
  );
});

// --- drift ---

test("diffOverrides reports nothing when the mirror matches", () => {
  assert.deepEqual(diffOverrides({ qs: "^6.16.0" }, { qs: "^6.16.0" }), []);
});

test("diffOverrides catches a pin upstream added that was never mirrored", () => {
  const problems = diffOverrides({ qs: "^6.16.0", tar: "^7.5.21" }, { qs: "^6.16.0" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing from pnpm-workspace\.yaml.*tar/);
});

test("diffOverrides catches a version bump that landed only on the npm side", () => {
  const problems = diffOverrides({ "jsdom>undici": "^7.29.0" }, { "jsdom>undici": "^7.0.0" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /version drift.*jsdom>undici/);
});

test("diffOverrides catches a stale pnpm entry upstream has dropped", () => {
  const problems = diffOverrides({}, { "gone>pkg": "^1.0.0" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /extra in pnpm-workspace\.yaml/);
});

// --- npm syntax the flattener must not corrupt ---

// npm documents "." as "the package itself". Composing `parent>.` would be a
// one-level selector pnpm cannot honor, which depth checking would wave through.
test('flattenNpmOverrides collapses npm\'s "." self-key onto the bare parent', () => {
  assert.deepEqual(
    { ...flattenNpmOverrides({ "@npm/foo": { ".": "1.0.0", "@npm/bar": "1.0.0" } }) },
    { "@npm/foo": "1.0.0", "@npm/foo>@npm/bar": "1.0.0" }
  );
});

test('a top-level "." has no parent package and is rejected', () => {
  assert.ok(findUnmappableKeys({ ".": "1.0.0" }).some((p: string) => /not a package name/.test(p)));
});

test("findUnmappableKeys rejects a . segment that survived as parent>.", () => {
  assert.ok(
    findUnmappableKeys({ "foo>.": "1.0.0" }).some((p: string) => /not a package name/.test(p))
  );
});

// JSON.parse creates __proto__ as an OWN property, so it reaches the flattener. On a
// normal accumulator the assignment hits the prototype setter and the key disappears.
test("flattenNpmOverrides retains a __proto__ key instead of dropping it", () => {
  const parsed = JSON.parse('{"__proto__":"^1.0.0","qs":"^6.16.0"}');
  const flat = flattenNpmOverrides(parsed);
  assert.ok(Object.keys(flat).includes("__proto__"), "__proto__ must survive the flattener");
  assert.ok(
    findUnmappableKeys(flat).some((p: string) => /not a package name/.test(p)),
    "__proto__ must then be rejected as a selector"
  );
});

test("findUnsupportedValues flags npm's $-prefixed direct-dependency reference", () => {
  assert.ok(
    findUnsupportedValues({ qs: "$qs" }).some((p: string) => /direct-dependency reference/.test(p))
  );
});

test("findUnsupportedValues flags an override that nests to an empty object", () => {
  const flat = flattenNpmOverrides({ foo: {}, qs: "^6.0.0" });
  assert.ok(findUnsupportedValues(flat).some((p: string) => /pins nothing/.test(p)));
});

test("findUnsupportedValues is silent on ordinary ranges", () => {
  assert.deepEqual(findUnsupportedValues({ qs: "^6.16.0", "jsdom>undici": "^7.29.0" }), []);
});

// --- degenerate inputs ---

test("flattenNpmOverrides tolerates undefined, null and empty input", () => {
  assert.deepEqual({ ...flattenNpmOverrides(undefined) }, {});
  assert.deepEqual({ ...flattenNpmOverrides(null) }, {});
  assert.deepEqual({ ...flattenNpmOverrides({}) }, {});
});

test("a prototype member name yields a sane diagnostic, not a native-code string", () => {
  const problems = diffOverrides({ constructor: "^1.0.0" }, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing from pnpm-workspace\.yaml: "constructor"/);
  assert.doesNotMatch(problems[0], /native code/);
});

test("diffOverrides returns several problems in a stable sorted order", () => {
  const problems = diffOverrides({ aaa: "^1.0.0", zzz: "^1.0.0" }, { mmm: "^1.0.0" });
  assert.equal(problems.length, 3);
  assert.deepEqual(problems, [...problems].sort());
});

// --- regressions from the Codex review gate ---

// pnpm refuses a non-string override value outright ("should be a string, but got
// number"), so comparing them for equality would pass a mirror that cannot install.
test("findUnsupportedValues rejects non-string override values", () => {
  for (const bad of [1, true, null]) {
    const problems = findUnsupportedValues({ foo: bad });
    assert.ok(
      problems.some((p: string) => /non-string value/.test(p)),
      `value ${String(bad)} must be rejected`
    );
  }
});

test("a non-string value mirrored identically on both sides still fails", () => {
  const problems = collectProblems({ foo: 1 }, { foo: 1 }, {}, {});
  assert.ok(problems.some((p: string) => /non-string value/.test(p)));
});

// The conflict diagnostic interpolates values; an empty-object marker is a Symbol and
// threw "Cannot convert a Symbol value to a string", losing the message it promised.
test("a collapse conflict involving an empty object reports instead of throwing", () => {
  const deviations = {
    "a>b>c": { target: "shared>c", reason: "fixture" },
    "d>b>c": { target: "shared>c", reason: "fixture" },
  };
  const problems = collectProblems(
    { a: { b: { c: {} } }, d: { b: { c: "^2.0.0" } } },
    { "shared>c": "^2.0.0" },
    deviations,
    {}
  );
  assert.ok(problems.length > 0, "must report");
  assert.ok(
    problems.some((p: string) => /<empty object>/.test(p)),
    "the empty-object side must be rendered, not thrown on"
  );
});

// --- end to end: the real script, the real yaml.load, real exit codes ---

// main() uses the script's real DEVIATIONS constant, and the stale-deviation check
// rightly fails on any state that no longer declares those npm keys. A fixture must
// therefore be a VALID repo state: it always carries the live deviation pair, and each
// test layers its own entries on top.
const LIVE_DEVIATION_NPM = {
  libxmljs2: { minimatch: { "brace-expansion": "^2.1.4" } },
  rimraf: { minimatch: { "brace-expansion": "^2.1.4" } },
  "@apidevtools/json-schema-ref-parser": { "js-yaml": "^4.3.1" },
  "lockfile-lint": { "js-yaml": "^4.3.1" },
  promptfoo: { undici: "^7.29.0" },
};
const LIVE_DEVIATION_YAML =
  '  "minimatch@9>brace-expansion": "^2.1.4"\n' +
  '  "@apidevtools/json-schema-ref-parser>js-yaml": "^5.2.3"\n' +
  '  "cosmiconfig>js-yaml": "^4.3.2"\n' +
  '  "promptfoo>undici": "^7.29.0"\n';

function runGate(npmOverrides: Record<string, unknown>, workspaceYaml: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrides-gate-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", overrides: { ...LIVE_DEVIATION_NPM, ...npmOverrides } })
  );
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), workspaceYaml);
  try {
    const stdout = execFileSync(process.execPath, [gatePath], {
      encoding: "utf8",
      env: { ...process.env, PNPM_OVERRIDES_GATE_ROOT: dir },
    });
    return { code: 0, out: stdout };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? -1,
      out: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("gate exits 0 on a matching mirror, through the real yaml.load path", () => {
  const result = runGate(
    { qs: "^6.16.0" },
    `overrides:\n${LIVE_DEVIATION_YAML}  "qs": "^6.16.0"\n`
  );
  assert.equal(result.code, 0);
  assert.match(result.out, /\[pnpm-overrides-sync\] OK/);
});

test("gate exits 1 when pnpm-workspace.yaml declares no overrides at all", () => {
  const result = runGate({ qs: "^6.16.0" }, 'packages:\n  - "packages/*"\n');
  assert.equal(result.code, 1);
  assert.match(result.out, /every pin is currently a no-op/);
});

test("gate exits 1 and names the drift when a pin is missing", () => {
  const result = runGate(
    { qs: "^6.16.0", tar: "^7.5.21" },
    `overrides:\n${LIVE_DEVIATION_YAML}  "qs": "^6.16.0"\n`
  );
  assert.equal(result.code, 1);
  assert.match(result.out, /missing from pnpm-workspace\.yaml.*tar/);
});

// --- the live repo ---

test("the gate passes against the current repo state", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const workspaceRaw = fs.readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");

  // Minimal reader for the flat `overrides:` block, so this test does not lean on the
  // gate's own parser to prove the gate's subject matter.
  const actual: Record<string, string> = {};
  let inBlock = false;
  for (const line of workspaceRaw.split("\n")) {
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^\S/.test(line)) break;
      const match = line.match(/^\s+"([^"]+)":\s*"([^"]+)"\s*$/);
      if (match) actual[match[1]] = match[2];
    }
  }

  assert.ok(Object.keys(actual).length > 0, "mini-reader found no overrides; it has drifted");
  assert.deepEqual(
    collectProblems(pkg.overrides ?? {}, actual),
    [],
    "pnpm-workspace.yaml overrides have drifted from package.json overrides"
  );
});
