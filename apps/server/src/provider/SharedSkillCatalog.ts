/**
 * SharedSkillCatalog — provider-agnostic filesystem discovery of portable
 * skills, used to layer skills into providers that have no native skill
 * mechanism of their own (or whose native skills don't already cover a
 * given name), so a skill authored under one provider's convention can be
 * referenced while running another.
 *
 * Skills live one directory per skill under `<config dir>/skills` (user
 * scope), `<cwd>/.agents/skills`, and `<cwd>/.claude/skills` (project
 * scope), each with a `SKILL.md` carrying YAML frontmatter and a markdown
 * instructions body. Later roots win on name collisions: user, `.agents`,
 * then `.claude`. This is the same layout `Drivers/ClaudeSkills.ts`
 * discovers for Claude specifically; this module generalizes the walk and
 * adds body reading so a skill's instructions can be inlined into another
 * provider's turn (see `ProviderCommandReactor.buildSendTurnRequestForThread`).
 *
 * @module provider/SharedSkillCatalog
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

export type SkillRootScope = "user" | "project";

export const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

export function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Enumerate skills across the given roots, in order. Discovery is
 * best-effort: unreadable roots and malformed skill entries are skipped so a
 * broken skill never degrades a provider snapshot. On name collisions, later
 * roots win.
 */
export const discoverSkillsFromRoots = Effect.fn("discoverSkillsFromRoots")(function* (
  roots: ReadonlyArray<{ directory: string; scope: SkillRootScope }>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load for whichever
      // provider owns this directory either — skip it rather than
      // surfacing a broken entry under its directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

/**
 * Read a skill's instructions body: the SKILL.md contents with the leading
 * YAML frontmatter block stripped. Best-effort: a skill file that fails to
 * read yields an empty string rather than failing the turn.
 */
export const readSkillBody = Effect.fn("readSkillBody")(function* (
  skillPath: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString(skillPath).pipe(Effect.orElseSucceed(() => ""));
  return contents.replace(FRONTMATTER_PATTERN, "").trim();
});

/**
 * Resolve the shared skill catalog's user-scope config directory,
 * independent of any specific provider's own settings: a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, else `~/.claude` — the
 * established portable-skill convention in this codebase. Unlike Claude's
 * own resolution (`Drivers/ClaudeSkills.ts`), this never honors a provider
 * instance's `homePath`, since the shared catalog isn't scoped to one
 * provider's configuration.
 */
const resolveSharedSkillsConfigDirPath = Effect.fn("resolveSharedSkillsConfigDirPath")(function* (
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * Enumerate the shared, cross-provider skill catalog: the user config dir,
 * workspace `.agents/skills`, and workspace `.claude/skills`, in that order.
 * This is the catalog non-Claude providers layer their own skill list with,
 * and that `ProviderCommandReactor` resolves `$name` turn-text references
 * against so any provider can reference a skill authored for another.
 */
export const discoverSharedSkills = Effect.fn("discoverSharedSkills")(function* (
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const configDirPath = yield* resolveSharedSkillsConfigDirPath(environment ?? process.env, cwd);

  const roots: ReadonlyArray<{ directory: string; scope: SkillRootScope }> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".claude", "skills"), scope: "project" as const },
        ]
      : []),
  ];

  return yield* discoverSkillsFromRoots(roots);
});

/**
 * `discoverSharedSkills`, tagged `origin: "shared"` and filtered against a
 * provider's own natively-discovered skill names so a provider never lists
 * (or gets asked to inject) a skill it already has. Providers with no
 * native skill mechanism of their own (Cursor, Grok, OpenCode) pass an
 * empty `nativeSkillNames` set; Codex passes the names from its own
 * `skills/list` RPC result.
 */
export const discoverSharedSkillsForProvider = Effect.fn("discoverSharedSkillsForProvider")(
  function* (
    cwd: string | undefined,
    environment: NodeJS.ProcessEnv | undefined,
    nativeSkillNames: ReadonlySet<string> = new Set(),
  ): Effect.fn.Return<
    ReadonlyArray<ServerProviderSkill>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const shared = yield* discoverSharedSkills(cwd, environment);
    return shared
      .filter((skill) => !nativeSkillNames.has(skill.name))
      .map((skill) => ({ ...skill, origin: "shared" as const }));
  },
);
