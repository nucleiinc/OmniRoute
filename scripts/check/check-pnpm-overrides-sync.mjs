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
//   - pnpm parses exactly ONE `parent>child` level. A parent may carry a version range
//     ("minimatch@9>brace-expansion") but that is still one level. npm's doubly-nested
//     entries therefore have NO pnpm equivalent and must be declared in DEVIATIONS.
//     Observed: pnpm 11.25.0 rejects a deeper selector outright —
//     `[ERR_PNPM_INVALID_SELECTOR] Cannot parse the "minimatch>brace-expansion" selector`
//     (pnpm.mjs:187063-187066 throws when the child half has no parseable alias).
//
// Four independent failure classes, because a mirror can be wrong while still looking
// mirrored. Each of these was a real false negative in the first version of this gate:
//   1. drift      — a pin missing from the YAML, a version mismatch, or a YAML-only entry.
//   2. conflict   — several npm keys collapse onto one pnpm key with DIFFERENT values.
//                   Keeping whichever wrote last hides an upstream bump to the others,
//                   and which one wins depends on key order in a file upstream controls.
//   3. unmappable — a key pnpm's selector parser cannot accept: more than one `>` level,
//                   or a segment that is not a package name. pnpm REFUSES these with
//                   ERR_PNPM_INVALID_SELECTOR and the whole install fails, so catching
//                   them here trades a terse install-time error for a precise one that
//                   names the offending key and what to do about it.
//   4. stale      — a DEVIATIONS entry whose npm key upstream has dropped (its recorded
//                   rationale is now silently false), or one missing a target or reason.
//                   Mirrors the `assertNoStale` convention in scripts/check/lib/allowlist.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as yaml from "js-yaml";

// Repo root. PNPM_OVERRIDES_GATE_ROOT exists so the test suite can point main() at a
// fixture pair of manifests; the script itself still resolves its imports from here,
// which a copied-to-tmp script could not do. Never set it outside tests.
const ROOT =
  process.env.PNPM_OVERRIDES_GATE_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Flattened npm key -> { target, value?, reason }.
//   target — the pnpm key this npm entry is expressed as.
//   value  — an optional range that REPLACES npm's. Needed when npm's own pin is wrong
//            for this tree: activating a dormant pin can break a package rather than
//            remediate it, and pnpm has no way to say "pin, but not like that".
//   npmValue — MANDATORY whenever `value` is set: the npm range this deviation was
//            written against. Without it a value deviation swallows every later upstream
//            bump to that pin, including a new security floor, and the gate still reports
//            OK. That is the failure this whole gate exists to prevent, so an override of
//            npm's value must expire the moment npm's value changes.
//   reason — mandatory. A deviation is a decision, not a shortcut.
// Two npm keys may share a target when pnpm cannot express them separately; their
// effective values must then agree, and failure class 2 enforces that.
const DEVIATIONS = {
  "libxmljs2>minimatch>brace-expansion": {
    target: "minimatch@9>brace-expansion",
    reason:
      "pnpm cannot express a two-level selector, so both of npm's brace-expansion pins " +
      "collapse onto one key scoped by minimatch major. Major 9 is the only one declaring " +
      "brace-expansion ^2.0.2, a range that ADMITS versions below the 2.1.4 upstream pins as the fix, which is why major 9 is the one needing a pin. Do NOT widen this to a bare " +
      "`minimatch>brace-expansion`: that drags minimatch 10 from brace-expansion 5.x down " +
      "to 2.x, which exports no named `expand`, and every eslint config-array path match " +
      "throws TypeError at runtime.",
  },
  "@apidevtools/json-schema-ref-parser>js-yaml": {
    target: "@apidevtools/json-schema-ref-parser>js-yaml",
    value: "^5.2.3",
    npmValue: "^4.3.1",
    reason:
      "npm pins ^4.3.1 here, which is wrong for this tree and was harmless only while " +
      "pnpm ignored npm's overrides entirely. Activating the mirror made it bite: " +
      "@apidevtools/json-schema-ref-parser@16.0.1 declares js-yaml ^5.2.3 and imports nine " +
      "named bindings from it, six of which (binaryTag, mergeTag, omapTag, pairsTag, setTag, " +
      "timestampTag) do not exist in 4.x, so the forced 4.3.2 throws SyntaxError at load. " +
      "^5.2.3 satisfies the declared range and still clears the js-yaml 5.x advisory " +
      "(GHSA-pm4m-ph32-ghv5, patched 5.2.2), so the pin's remediation intent is preserved. " +
      "Dev-only reach (promptfoo). Report upstream: npm applies the same downgrade.",
  },
  "lockfile-lint>js-yaml": {
    target: "cosmiconfig>js-yaml",
    value: "^4.3.2",
    npmValue: "^4.3.1",
    reason:
      "npm's nested overrides are subtree-scoped; pnpm's parent>child matches only a DIRECT " +
      "edge. lockfile-lint@5.0.1 depends on cosmiconfig/debug/lockfile-lint-api/tinyglobby/" +
      "yargs and has no direct js-yaml, so mirroring npm's key verbatim binds nothing and " +
      "the guard is silently lost. js-yaml sits one hop further down under cosmiconfig@9.0.2 " +
      "(declares ^4.1.0, resolves 4.3.2), so retargeting there restores the protection. " +
      "^4.3.2 is the patch point for the highest 4.x advisory (GHSA-2883-xcg3-v3hh). This is " +
      "broader than npm's scope: it also covers cosmiconfig under other parents, which is " +
      "strictly more protective and pins nothing to a vulnerable version.",
  },
  "rimraf>minimatch>brace-expansion": {
    target: "minimatch@9>brace-expansion",
    reason:
      "Same collapse as the libxmljs2 entry above: one pnpm key covers both npm parents, " +
      "scoped to minimatch major 9 for the reason recorded there. Coverage was checked " +
      "rather than assumed: every minimatch reachable under either parent is 9.0.9, and " +
      "brace-expansion 2.x has exactly one consumer in the whole tree (minimatch@9.0.9), " +
      "so the broadened selector reaches the same single edge and pins nothing extra. " +
      "Neither parent declares minimatch directly (libxmljs2 -> bindings/nan/node-gyp/" +
      "prebuild-install, rimraf -> glob), so this selector is at least as effective as " +
      "npm's original pair.",
  },
};

// npm's nested overrides are SUBTREE-scoped: they bind the child at any depth under the
// parent. pnpm's `parent>child` binds only a DIRECT edge. Mirroring a nested npm key
// verbatim therefore narrows its scope, and the gate cannot see that: it compares keys and
// ranges, not resolved trees.
//
// Narrowing is not always a loss. Where npm's broader scope would force a major downgrade
// onto a descendant that declares a newer range, the narrower pnpm scope is what keeps the
// tree working. Each such case is recorded here so nobody "fixes" the coverage gap into a
// break. Keys are validated against package.json so an entry cannot go stale.
const DELIBERATE_SCOPE_NARROWING = {
  "promptfoo>undici": {
    reason:
      "npm's subtree scope would force undici ^7.29.0 onto @apidevtools/json-schema-ref-" +
      "parser@16.0.1, which declares ^8.10.0 and resolves 8.10.2. pnpm's direct-edge match " +
      "leaves that descendant alone, which is why it still works. Do NOT widen this to cover " +
      "the subtree: it is the same major-downgrade trap that the js-yaml deviation above " +
      "exists to undo. promptfoo's own direct undici edge IS pinned by this entry.",
  },
};

/** Render any value for a diagnostic without ever throwing (e.g. {toString: null}). */
function show(value) {
  if (value === EMPTY_OVERRIDE) return "<empty object>";
  try {
    return String(value);
  } catch {
    try {
      return JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
}

/** Marker for an npm override that nested down to nothing. */
export const EMPTY_OVERRIDE = Symbol.for("omniroute.emptyOverride");

// One segment of a pnpm selector: a package name, optionally scoped, optionally
// carrying an "@range" suffix ("minimatch@9"). npm forbids uppercase and a leading
// "_" or ".", so this also rejects "__proto__" and npm's "." self-key, neither of
// which is a package name and neither of which pnpm can honor as a selector segment.
const SELECTOR_SEGMENT = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:@.+)?$/;

/**
 * Flatten npm's nested `overrides` into pnpm's flat `parent>child` key form.
 *
 * Accumulates on a null-prototype object: a key named `__proto__` would otherwise hit
 * the prototype setter and vanish from the result entirely.
 *
 * npm's "." key means "the parent package itself" and is documented as such, so it
 * collapses to the bare parent key. Composing `parent>.` instead would produce a
 * selector pnpm cannot honor, and it carries only one ">" so depth checking misses it.
 */
export function flattenNpmOverrides(overrides, prefix = "") {
  const out = Object.create(null);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key === ".") {
      // A bare "." at the top level has no parent package and means nothing.
      out[prefix || "."] = value;
      continue;
    }
    const composed = prefix ? `${prefix}>${key}` : key;
    if (value && typeof value === "object") {
      const nested = flattenNpmOverrides(value, composed);
      if (Object.keys(nested).length === 0) {
        // `"foo": {}` carries no pin. Surface it rather than consuming it in silence,
        // which is the same failure shape this gate exists to prevent.
        out[composed] = EMPTY_OVERRIDE;
      }
      Object.assign(out, nested);
    } else {
      out[composed] = value;
    }
  }
  return out;
}

/**
 * Apply DEVIATIONS to flattened npm keys.
 * Returns the expected pnpm map AND every collapse conflict, so a many-to-one rewrite
 * can never quietly discard a divergent value.
 */
export function expectedPnpmOverrides(flatNpm, deviations = DEVIATIONS) {
  const expected = Object.create(null);
  const sources = Object.create(null);
  for (const [npmKey, npmValue] of Object.entries(flatNpm)) {
    const deviation = deviations[npmKey];
    const target = deviation?.target ?? npmKey;
    // A declared value deviation replaces npm's range deliberately; conflicts are then
    // judged on what pnpm will actually apply, not on what npm asked for.
    const value = deviation?.value ?? npmValue;
    (sources[target] ??= []).push({ npmKey, value });
    expected[target] = value;
  }
  const conflicts = [];
  for (const [target, entries] of Object.entries(sources)) {
    if (new Set(entries.map((e) => e.value)).size > 1) {
      const detail = entries
        .map(
          (e) => `${e.npmKey}=${e.value === EMPTY_OVERRIDE ? "<empty object>" : String(e.value)}`
        )
        .join(", ");
      conflicts.push(
        `"${target}" is the deviation target of ${entries.length} npm keys with DIFFERENT ` +
          `values (${detail}); pnpm holds only one, so at least one pin would be a no-op`
      );
    }
  }
  return { expected, conflicts: conflicts.sort() };
}

/**
 * Keys pnpm's selector parser will refuse. Two distinct ways that happens, and depth
 * alone catches only the first:
 *   - more than one `>` level survived the deviation map (npm allows arbitrary nesting,
 *     pnpm parses exactly one);
 *   - a segment that is not a package name, e.g. npm's "." self-key, which yields a
 *     one-level `parent>.` that depth checking would wave through.
 * Both make `pnpm install` exit non-zero with ERR_PNPM_INVALID_SELECTOR. Reporting them
 * here is not redundant: it names the key and the remedy instead of leaving a maintainer
 * to work backwards from pnpm's one-line parse error.
 */
export function findUnmappableKeys(expected) {
  const bad = [];
  // npm's "." self-key on a version-qualified parent repins that parent, which leaves its
  // own `parent@range>child` selectors pointing at a version that no longer exists in the
  // tree, so the child pins bind nothing. Conservative and fail-closed: any version-
  // qualified key that is itself pinned AND scopes children needs an explicit deviation.
  for (const key of Object.keys(expected)) {
    if (key.includes(">") || !key.includes("@", 1)) continue;
    const children = Object.keys(expected).filter((k) => k.startsWith(`${key}>`));
    if (children.length > 0) {
      bad.push(
        `"${key}" is a version-qualified parent that is itself pinned to ` +
          `${String(expected[key])} while also scoping ${children.length} child pin(s) ` +
          `(${children.join(", ")}). Repinning the parent leaves those child selectors ` +
          `matching a version that is no longer installed, so they bind nothing. Add a ` +
          `DEVIATIONS entry naming the resulting parent version`
      );
    }
  }
  for (const key of Object.keys(expected)) {
    const segments = key.split(">");
    if (segments.length > 2) {
      bad.push(
        `"${key}" has ${segments.length - 1} ">" levels; pnpm parses one and rejects the ` +
          `rest with ERR_PNPM_INVALID_SELECTOR, failing the install. Add a DEVIATIONS ` +
          `entry choosing a one-level target and recording why`
      );
      continue;
    }
    const offender = segments.find((segment) => !SELECTOR_SEGMENT.test(segment));
    if (offender !== undefined) {
      bad.push(
        `"${key}" is not a usable pnpm selector: segment "${offender}" is not a package ` +
          `name, so pnpm rejects it with ERR_PNPM_INVALID_SELECTOR and the install fails` +
          (offender === "." ? ' (npm\'s "." self-key becomes the bare parent key)' : "")
      );
    }
  }
  return bad.sort();
}

/**
 * Override VALUES pnpm may not interpret as npm does. npm resolves a `$name` value to
 * the spec of that direct dependency; whether pnpm honors it is unconfirmed, so this
 * fails closed. A false positive costs a maintainer minutes; a false negative restores
 * the vulnerability the pin was added to close.
 */
export function findUnsupportedValues(expected) {
  const problems = [];
  for (const [key, value] of Object.entries(expected)) {
    if (value === EMPTY_OVERRIDE) {
      problems.push(`"${key}" nests to an empty object in package.json, so it pins nothing`);
    } else if (typeof value !== "string") {
      // pnpm refuses these outright: "The value of overrides.<key> should be a string,
      // but got number". Comparing them for equality would pass a mirror that cannot install.
      problems.push(
        `"${key}" has a non-string value (${value === null ? "null" : typeof value}); pnpm ` +
          `requires every override value to be a string and fails the install otherwise`
      );
    } else if (value.startsWith("$")) {
      problems.push(
        `"${key}" uses npm's "${value}" direct-dependency reference; pnpm's support for ` +
          `$-prefixed override values is unconfirmed, so mirroring it verbatim risks a ` +
          `silent no-op. Resolve it to a literal range, or add a DEVIATIONS entry`
      );
    }
  }
  return problems.sort();
}

/**
 * DEVIATIONS entries upstream no longer declares, or that omit a target or reason.
 * Also validates DELIBERATE_SCOPE_NARROWING the same way, so a recorded decision cannot
 * outlive the npm entry it describes.
 */
export function findScopeNarrowingProblems(flatNpm, narrowing = DELIBERATE_SCOPE_NARROWING) {
  const problems = [];
  for (const [npmKey, entry] of Object.entries(narrowing ?? {})) {
    if (!(npmKey in flatNpm)) {
      problems.push(
        `stale DELIBERATE_SCOPE_NARROWING entry "${npmKey}": package.json no longer ` +
          `declares it, so the decision it records no longer applies — remove it`
      );
    }
    if (!entry?.reason) {
      problems.push(`DELIBERATE_SCOPE_NARROWING entry "${npmKey}" has no reason`);
    }
  }
  return problems.sort();
}

/** DEVIATIONS entries upstream no longer declares, or that omit a target or reason. */
export function findDeviationProblems(flatNpm, deviations = DEVIATIONS) {
  const problems = [];
  for (const [npmKey, entry] of Object.entries(deviations)) {
    if (!(npmKey in flatNpm)) {
      problems.push(
        `stale DEVIATIONS entry "${npmKey}": package.json no longer declares it, so the ` +
          `rationale recorded for target "${entry?.target}" may no longer hold — remove it`
      );
    }
    if (!entry?.target) problems.push(`DEVIATIONS entry "${npmKey}" has no target`);
    if (entry?.value !== undefined && typeof entry.value !== "string") {
      problems.push(`DEVIATIONS entry "${npmKey}" has a non-string value override`);
    }
    if (entry?.value !== undefined && entry?.npmValue === undefined) {
      problems.push(
        `DEVIATIONS entry "${npmKey}" overrides npm's value but records no npmValue; ` +
          `without it a later upstream bump would be swallowed silently`
      );
    }
    if (entry?.npmValue !== undefined && npmKey in flatNpm && flatNpm[npmKey] !== entry.npmValue) {
      problems.push(
        `DEVIATIONS entry "${npmKey}" was written against npm's ${entry.npmValue} but ` +
          `package.json now says ${String(flatNpm[npmKey])}. The override to ` +
          `${String(entry.value)} may no longer be correct — and if the bump is a new ` +
          `security floor, keeping the old override would hide it. Reconsider, then update ` +
          `npmValue`
      );
    }
    if (!entry?.reason) problems.push(`DEVIATIONS entry "${npmKey}" has no reason`);
  }
  return problems.sort();
}

/**
 * Compare expected against actual, returning human-readable drift lines.
 * `expected` may carry a DEVIATIONS value override, so the wording says "expected"
 * rather than attributing the range to package.json, which may not hold it.
 */
export function diffOverrides(expected, actual) {
  const problems = [];
  for (const [key, value] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, key)) {
      problems.push(`missing from pnpm-workspace.yaml: "${key}": "${show(value)}"`);
    } else if (actual[key] !== value) {
      problems.push(
        `version drift on "${key}": expected ${show(value)} (package.json, or a ` +
          `DEVIATIONS value override), pnpm has ${show(actual[key])}`
      );
    }
  }
  for (const key of Object.keys(actual)) {
    if (!Object.hasOwn(expected, key)) {
      problems.push(`extra in pnpm-workspace.yaml, not in package.json: "${key}"`);
    }
  }
  return problems.sort();
}

/** All four failure classes for one pair of manifests, in one list. */
export function collectProblems(
  npmOverrides,
  pnpmOverrides,
  deviations = DEVIATIONS,
  narrowing = DELIBERATE_SCOPE_NARROWING
) {
  const flatNpm = flattenNpmOverrides(npmOverrides);
  const { expected, conflicts } = expectedPnpmOverrides(flatNpm, deviations);
  // An empty-nest marker is reported by findUnsupportedValues; it is not a mirror
  // drift, and it is not a range the YAML could ever match. Keep it out of the diff.
  const diffable = Object.create(null);
  for (const [key, value] of Object.entries(expected)) {
    if (value !== EMPTY_OVERRIDE) diffable[key] = value;
  }
  return [
    ...conflicts,
    ...findUnmappableKeys(expected),
    ...findUnsupportedValues(expected),
    ...findDeviationProblems(flatNpm, deviations),
    ...findScopeNarrowingProblems(flatNpm, narrowing),
    ...diffOverrides(diffable, pnpmOverrides),
  ];
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
    const { expected } = expectedPnpmOverrides(flattenNpmOverrides(npmOverrides));
    console.error(`  → restore these ${Object.keys(expected).length} key(s) under \`overrides:\`:`);
    for (const [key, value] of Object.entries(expected)) {
      console.error(`      "${key}": "${String(value)}"`);
    }
    process.exit(1);
  }

  const problems = collectProblems(npmOverrides, pnpmOverrides);

  if (problems.length === 0) {
    const { expected } = expectedPnpmOverrides(flattenNpmOverrides(npmOverrides));
    console.log(
      `[pnpm-overrides-sync] OK — ${Object.keys(expected).length} override(s) mirrored into pnpm-workspace.yaml`
    );
    process.exit(0);
  }

  console.error(
    `[pnpm-overrides-sync] FAIL — ${problems.length} problem(s) between npm and pnpm overrides:`
  );
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    "\n  → Upstream changed package.json `overrides`. Mirror the change into" +
      "\n    pnpm-workspace.yaml `overrides`, converting npm's nested form to pnpm's" +
      "\n    `parent>child` selectors. pnpm parses ONE level only: never paste a key" +
      "\n    carrying two or more `>`, because pnpm rejects it and the install fails." +
      "\n    A deeper npm nest needs a DEVIATIONS entry in this script naming the" +
      "\n    one-level target you chose and the reason. Re-run `pnpm install` after." +
      "\n  → A pin that exists only in package.json does nothing on a pnpm install."
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
