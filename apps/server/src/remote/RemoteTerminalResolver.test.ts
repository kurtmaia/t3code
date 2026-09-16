import { describe, expect, it } from "vite-plus/test";

import type { ProjectionProject } from "../persistence/Services/ProjectionProjects.ts";
import { findOwningProject } from "./RemoteTerminalResolver.ts";

const project = (
  id: string,
  workspaceRoot: string,
  remote: ProjectionProject["remote"],
  deleted = false,
): ProjectionProject =>
  ({
    projectId: id,
    title: id,
    workspaceRoot,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    remote,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: deleted ? "2026-01-02T00:00:00.000Z" : null,
  }) as unknown as ProjectionProject;

const binding = { host: "buildbox", remotePath: "/srv/app" };

describe("findOwningProject", () => {
  it("matches the project root itself", () => {
    const rows = [project("p1", "/work/app", binding)];
    expect(findOwningProject(rows, "/work/app")?.projectId).toBe("p1");
  });

  it("matches a subdirectory of the project", () => {
    const rows = [project("p1", "/work/app", binding)];
    expect(findOwningProject(rows, "/work/app/packages/api")?.projectId).toBe("p1");
  });

  it("picks the innermost project when one is nested inside another", () => {
    const rows = [project("outer", "/work", binding), project("inner", "/work/app", binding)];
    expect(findOwningProject(rows, "/work/app/src")?.projectId).toBe("inner");
  });

  it("does not match a sibling that merely shares a name prefix", () => {
    // `/work/app-archive` starts with `/work/app` as a string but is not inside it.
    const rows = [project("p1", "/work/app", binding)];
    expect(findOwningProject(rows, "/work/app-archive")).toBeUndefined();
  });

  it("ignores purely local projects", () => {
    const rows = [project("p1", "/work/app", null)];
    expect(findOwningProject(rows, "/work/app")).toBeUndefined();
  });

  it("ignores deleted projects", () => {
    const rows = [project("p1", "/work/app", binding, true)];
    expect(findOwningProject(rows, "/work/app")).toBeUndefined();
  });

  it("normalizes traversal segments before comparing", () => {
    const rows = [project("p1", "/work/app", binding)];
    expect(findOwningProject(rows, "/work/app/src/../lib")?.projectId).toBe("p1");
    expect(findOwningProject(rows, "/work/app/../other")).toBeUndefined();
  });

  it("returns nothing for a directory no project owns", () => {
    const rows = [project("p1", "/work/app", binding)];
    expect(findOwningProject(rows, "/somewhere/else")).toBeUndefined();
  });
});
