/**
 * The Cursor Agent CLI version pin, alone in a dependency leaf.
 *
 * This constant is the only thing `src/lib/oauth/constants/oauth.ts` needs from
 * `cursorAgentCliVersion.ts`, but that module imports `node:fs`, `node:os` and
 * `node:path` for local-install detection. `oauth.ts` is reachable from the
 * "use client" CliAgentsPageClient (via cliTools → providerRegistry →
 * providers/index → codebuddy-cn), so importing the constant from there pulled
 * the `node:` scheme into the browser bundle and webpack failed the production
 * build with `UnhandledSchemeError: Reading from "node:path" is not handled by
 * plugins`.
 *
 * This file has no imports at all — a true dependency leaf — so client code can
 * read the pin safely. `cursorAgentCliVersion.ts` re-exports it, so it remains
 * the single source of truth and existing importers are unaffected. Keep this
 * file import-free; `tests/unit/client-safe-leaf-modules.test.ts` enforces it.
 */

/**
 * Pinned Agent CLI build id used when no local install is found (typical
 * headless OmniRoute). Bump when refreshing Cursor CLI impersonation.
 */
export const CURSOR_AGENT_CLI_VERSION = "2026.07.08-0c04a8a";
