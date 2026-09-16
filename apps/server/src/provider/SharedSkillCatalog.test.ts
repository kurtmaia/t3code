import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverSharedSkills,
  discoverSharedSkillsForProvider,
  readSkillBody,
} from "./SharedSkillCatalog.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverSharedSkills", (it) => {
  it.effect("discovers user and project skills, ignoring provider homePath", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-skills-" });
      const configDir = path.join(tempDir, "shared-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "second-opinion",
        [
          "---",
          "name: second-opinion",
          "description: Get an independent review.",
          "---",
          "",
          "# Body",
          "",
          "Ask another model to review the diff.",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverSharedSkills(workspace, { CLAUDE_CONFIG_DIR: configDir });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["deploy", "second-opinion"],
      );
    }),
  );

  it.effect("readSkillBody strips frontmatter and returns the instructions text", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-skills-" });
      const skillsDir = path.join(tempDir, "skills");

      yield* writeSkill(
        skillsDir,
        "second-opinion",
        [
          "---",
          "name: second-opinion",
          "description: Get an independent review.",
          "---",
          "",
          "# Second Opinion",
          "",
          "Ask another model to review the diff.",
        ].join("\n"),
      );

      const body = yield* readSkillBody(path.join(skillsDir, "second-opinion", "SKILL.md"));

      assert.equal(body, "# Second Opinion\n\nAsk another model to review the diff.");
    }),
  );

  it.effect("readSkillBody returns an empty string for an unreadable path", () =>
    Effect.gen(function* () {
      const body = yield* readSkillBody("/nonexistent/path/SKILL.md");
      assert.equal(body, "");
    }),
  );

  it.effect("prefers workspace .claude skills on collisions with the shared user catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-skills-" });
      const configDir = path.join(tempDir, "shared-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverSharedSkills(workspace, { CLAUDE_CONFIG_DIR: configDir });

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "project");
      assert.equal(skills[0]?.description, "Project deploy.");
    }),
  );

  it.effect("discoverSharedSkillsForProvider tags shared entries and drops native collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-shared-skills-" });
      const configDir = path.join(tempDir, "shared-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "second-opinion",
        ["---", "name: second-opinion", "description: Get a review.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(configDir, "skills"),
        "already-native",
        ["---", "name: already-native", "---"].join("\n"),
      );

      const skills = yield* discoverSharedSkillsForProvider(
        workspace,
        { CLAUDE_CONFIG_DIR: configDir },
        new Set(["already-native"]),
      );

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["second-opinion"],
      );
      assert.equal(skills[0]?.origin, "shared");
    }),
  );
});
