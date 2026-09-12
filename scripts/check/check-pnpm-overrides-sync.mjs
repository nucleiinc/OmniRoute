#!/usr/bin/env node
// scripts/check/check-pnpm-overrides-sync.mjs
// Gate: fails when pnpm-workspace.yaml `overrides` drifts from package.json `overrides`.
//
// Why this gate exists (fork-local, nucleiinc):
// Upstream pins transitive dependencies through npm's top-level `overrides` field,
// and most of those pins are Dependabot remediations. pnpm does not read that field.
// On a pnpm install every one of them silently does nothing — no warning, no error,
// just the vulnerable version still in the tree. That is how @openai/codex-security
// kept resolving smol-toml 1.6.1 after upstream pinned ^1.8.0 to close its alert.
//
// This fork therefore mirrors the block into pnpm-workspace.yaml, which pnpm does
// read. A mirror only works if it stays in sync, and nothing about merging upstream
// forces that: a merge can add an npm override and leave the pnpm side untouched.
// This gate is the thing that notices.
//
// Translation rules (npm -> pnpm):
//   - A flat entry maps across unchanged:   "qs": "^6.16.0"
//   - npm nests objects to scope an override to a parent; pnpm uses a `>` selector:
//       npm:  "jsdom": { "undici": "^7.29.0" }
//       pnpm: "jsdom>undici": "^7.29.0"
//   - pnpm parses exactly ONE `parent>child` level. npm's doubly-nested entries have
//     no direct equivalent and must be declared in DEVIATIONS below.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as yaml from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// npm key (flattened) -> pnpm key it is deliberately expressed as.
// Every entry needs a reason: a deviation is a decision, not a shortcut.
const DEVIATIONS = {
  // pnpm cannot express `libxmljs2>minimatch>brace-expansion` (two levels deep), so
  // both of npm's brace-expansion pins collapse into one selector scoped by minimatch
  // major. Major 9 is the only one declaring brace-expansion ^2.0.2, the range the
  // advisory covers. Do NOT widen this to a bare `minimatch>brace-expansion`: that
  // drags minimatch 10 from brace-expansion 5.x down to 2.x, which exports no named
  // `expand`, and every eslint config-array path match throws TypeError at runtime.
  "libxmljs2>minimatch>brace-expansion": "minimatch@9>brace-expansion",
  "rimraf>minimatch>brace-expansion": "minimatch@9>brace-expansion",
};

/** Flatten npm's nested `overrides` into pnpm's flat `parent>child` key form. */
export function flattenNpmOverrides(overrides, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const composed = prefix ? `${prefix}>${key}` : key;
    if (value && typeof value === "object") {
      Object.assign(out, flattenNpmOverrides(value, composed));
    } else {
      out[composed] = value;
    }
  }
  return out;
}

/** Apply DEVIATIONS, returning the pnpm keys the workspace file is expected to hold. */
export function expectedPnpmOverrides(flatNpm, deviations = DEVIATIONS) {
  const out = {};
  for (const [key, value] of Object.entries(flatNpm)) {
    out[deviations[key] ?? key] = value;
  }
  return out;
}

/** Compare expected against actual, returning a list of human-readable drift lines. */
export function diffOverrides(expected, actual) {
  const problems = [];
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in actual)) {
      problems.push(`missing from pnpm-workspace.yaml: "${key}": "${value}"`);
    } else if (actual[key] !== value) {
      problems.push(
        `version drift on "${key}": package.json wants ${value}, pnpm has ${actual[key]}`
      );
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) {
      problems.push(`extra in pnpm-workspace.yaml, not in package.json: "${key}"`);
    }
  }
  return problems.sort();
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const workspace = yaml.load(fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8"));

  const npmOverrides = pkg.overrides ?? {};
  const pnpmOverrides = workspace?.overrides ?? {};

  if (Object.keys(npmOverrides).length > 0 && Object.keys(pnpmOverrides).length === 0) {
    console.error(
      "[pnpm-overrides-sync] FAIL — package.json declares overrides but pnpm-workspace.yaml has none."
    );
    console.error("  → pnpm ignores npm's `overrides` field; every pin is currently a no-op.");
    process.exit(1);
  }

  const expected = expectedPnpmOverrides(flattenNpmOverrides(npmOverrides));
  const problems = diffOverrides(expected, pnpmOverrides);

  if (problems.length === 0) {
    console.log(
      `[pnpm-overrides-sync] OK — ${Object.keys(expected).length} override(s) mirrored into pnpm-workspace.yaml`
    );
    process.exit(0);
  }

  console.error(
    `[pnpm-overrides-sync] FAIL — ${problems.length} drift(s) between npm and pnpm overrides:`
  );
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    "\n  → Upstream changed package.json `overrides`. Mirror the change into" +
      "\n    pnpm-workspace.yaml `overrides`, flattening npm's nested form to" +
      "\n    pnpm's `parent>child` selectors, then re-run `pnpm install`." +
      "\n  → A pin that exists only in package.json does nothing on a pnpm install."
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
