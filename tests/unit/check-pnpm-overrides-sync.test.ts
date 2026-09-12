import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// @ts-expect-error — plain .mjs gate, no types
import {
  diffOverrides,
  expectedPnpmOverrides,
  flattenNpmOverrides,
} from "../../scripts/check/check-pnpm-overrides-sync.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("flattenNpmOverrides keeps flat entries unchanged", () => {
  assert.deepEqual(flattenNpmOverrides({ qs: "^6.16.0", tar: "^7.5.21" }), {
    qs: "^6.16.0",
    tar: "^7.5.21",
  });
});

test("flattenNpmOverrides converts npm's nested form to pnpm's > selector", () => {
  assert.deepEqual(flattenNpmOverrides({ jsdom: { undici: "^7.29.0" } }), {
    "jsdom>undici": "^7.29.0",
  });
});

test("flattenNpmOverrides expands a parent pinning several children", () => {
  assert.deepEqual(flattenNpmOverrides({ promptfoo: { "js-yaml": "^5.2.2", undici: "^7.29.0" } }), {
    "promptfoo>js-yaml": "^5.2.2",
    "promptfoo>undici": "^7.29.0",
  });
});

test("flattenNpmOverrides walks arbitrarily deep nesting", () => {
  assert.deepEqual(
    flattenNpmOverrides({ libxmljs2: { minimatch: { "brace-expansion": "^2.1.4" } } }),
    { "libxmljs2>minimatch>brace-expansion": "^2.1.4" }
  );
});

test("expectedPnpmOverrides rewrites a key through its declared deviation", () => {
  const flat = { "libxmljs2>minimatch>brace-expansion": "^2.1.4" };
  const deviations = { "libxmljs2>minimatch>brace-expansion": "minimatch@9>brace-expansion" };
  assert.deepEqual(expectedPnpmOverrides(flat, deviations), {
    "minimatch@9>brace-expansion": "^2.1.4",
  });
});

test("expectedPnpmOverrides collapses two npm keys that share one deviation target", () => {
  const flat = {
    "libxmljs2>minimatch>brace-expansion": "^2.1.4",
    "rimraf>minimatch>brace-expansion": "^2.1.4",
  };
  const deviations = {
    "libxmljs2>minimatch>brace-expansion": "minimatch@9>brace-expansion",
    "rimraf>minimatch>brace-expansion": "minimatch@9>brace-expansion",
  };
  assert.deepEqual(Object.keys(expectedPnpmOverrides(flat, deviations)), [
    "minimatch@9>brace-expansion",
  ]);
});

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

test("the gate passes against the current repo state", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const workspaceRaw = fs.readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");

  // Minimal reader for the flat `overrides:` block, so this test does not depend on
  // the gate's own yaml parsing to prove the gate's subject matter.
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

  const expected = expectedPnpmOverrides(flattenNpmOverrides(pkg.overrides ?? {}));
  assert.deepEqual(
    diffOverrides(expected, actual),
    [],
    "pnpm-workspace.yaml overrides have drifted from package.json overrides"
  );
});
