import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-context-root-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-context-root-" });
});

it.layer(TestLayer)("normalizeDispatchCommand contextRoot", (it) => {
  describe("project.create", () => {
    it.effect("absolutizes an existing context root and leaves a missing one as an error", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeTempDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const repo = path.join(root, "repo");
        yield* fileSystem.makeDirectory(repo);

        const normalized = yield* normalizeDispatchCommand({
          type: "project.create",
          commandId: CommandId.make("cmd-1"),
          projectId: ProjectId.make("project-1"),
          title: "Repo",
          workspaceRoot: repo,
          contextRoot: `${root}${path.sep}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        expect(normalized.type === "project.create" && normalized.contextRoot).toBe(root);

        const failure = yield* Effect.flip(
          normalizeDispatchCommand({
            type: "project.create",
            commandId: CommandId.make("cmd-2"),
            projectId: ProjectId.make("project-2"),
            title: "Repo",
            workspaceRoot: repo,
            contextRoot: path.join(root, "missing"),
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        );
        expect(failure.message).toContain("does not exist");
      }),
    );
  });

  describe("project.meta.update", () => {
    it.effect("normalizes a context root on its own and passes null through as a clear", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeTempDir();

        const set = yield* normalizeDispatchCommand({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-3"),
          projectId: ProjectId.make("project-1"),
          contextRoot: `${root}${path.sep}`,
        });
        expect(set.type === "project.meta.update" && set.contextRoot).toBe(root);
        expect("workspaceRoot" in set).toBe(false);

        const clear = yield* normalizeDispatchCommand({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-4"),
          projectId: ProjectId.make("project-1"),
          contextRoot: null,
        });
        expect(clear.type === "project.meta.update" && clear.contextRoot).toBeNull();
      }),
    );
  });
});
