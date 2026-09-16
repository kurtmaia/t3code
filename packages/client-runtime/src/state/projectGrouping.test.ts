import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  groupByContextRoot,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("environment");
const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: "github",
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function settings(
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
  overrides: ProjectGroupingSettings["sidebarProjectGroupingOverrides"] = {},
): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: mode,
    sidebarProjectGroupingOverrides: overrides,
  };
}

describe("buildProjectGroups", () => {
  it("preserves every physical clone as a selectable member in repository modes", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    for (const mode of ["repository", "repository_path"] as const) {
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.members.map((member) => member.project.id)).toEqual([
        "t3code",
        "t3code-2",
        "t3code-3",
      ]);
      expect(groups[0]?.memberProjectRefs).toHaveLength(3);
    }
  });

  it("uses a shared custom title as the repository group's label", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "Custom project" }),
      makeProject("second", "/work/t3code-2", { title: "Custom project" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "Custom project",
    );
  });

  it("keeps the repository label when shared titles match its repository name", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "t3code" }),
      makeProject("second", "/work/t3code-2", { title: "t3code" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "T3 Code",
    );
  });

  it("keeps physical clones in separate groups when requested", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("separate") });
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((group) => group.members)).toHaveLength(3);
    expect(groups.map((group) => group.label)).toEqual(["t3code", "t3code-2", "t3code-3"]);
  });

  it("applies a physical-project override without dropping its siblings", () => {
    const first = makeProject("t3code", "/work/t3code");
    const second = makeProject("t3code-2", "/work/t3code-2");
    const third = makeProject("t3code-3", "/work/t3code-3");
    const groups = buildProjectGroups({
      projects: [first, second, third],
      settings: settings("repository", {
        [derivePhysicalProjectKey(second)]: "separate",
      }),
    });

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
      "t3code",
      "t3code-3",
      "t3code-2",
    ]);
  });

  it("dedupes stale registrations at one physical path using the freshest project", () => {
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    const groups = buildProjectGroups({
      projects: [stale, fresh],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(1);
    expect(groups[0]?.representative.id).toBe("fresh");
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("uses repository identity from a duplicate registration when the winner lacks it", () => {
    const identified = makeProject("identified", "/work/t3code", {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshUnidentified = makeProject("fresh", "/work/t3code/", {
      repositoryIdentity: null,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [identified, freshUnidentified, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest winner's repository identity when stale duplicates disagree", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [stale, fresh, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest identity-bearing duplicate when the winner lacks identity", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const staleIdentified = makeProject("stale-identified", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshIdentified = makeProject("fresh-identified", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const winner = makeProject("winner", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [staleIdentified, freshIdentified, winner, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["winner", "sibling"]);
  });
});

describe("groupByContextRoot", () => {
  const ids = (sections: ReadonlyArray<{ items: ReadonlyArray<EnvironmentProject> }>) =>
    sections.map((section) => section.items.map((item) => item.id));

  it("keeps projects without a context root in one unlabeled section", () => {
    const sections = groupByContextRoot(
      [makeProject("a", "/work/a"), makeProject("b", "/work/b")],
      (project) => project,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: null, label: null, contextRoot: null });
    expect(ids(sections)).toEqual([["a", "b"]]);
  });

  it("labels a section by the folder name and puts the folder's own project first", () => {
    const sections = groupByContextRoot(
      [
        makeProject("model", "/work/freight/nam-freight-model", { contextRoot: "/work/freight" }),
        makeProject("loose", "/work/loose"),
        makeProject("freight", "/work/freight", { contextRoot: "/work/freight/" }),
        makeProject("data", "/work/freight/nam-freight-data", { contextRoot: "/work/freight/" }),
      ],
      (project) => project,
    );
    expect(sections.map((section) => section.label)).toEqual(["freight", null]);
    expect(ids(sections)).toEqual([["freight", "model", "data"], ["loose"]]);
  });

  it("emits sections in order of first appearance so the caller's sort is preserved", () => {
    const sections = groupByContextRoot(
      [
        makeProject("p-api", "/work/pricing/api", { contextRoot: "/work/pricing" }),
        makeProject("solo", "/work/solo"),
        makeProject("f-model", "/work/freight/model", { contextRoot: "/work/freight" }),
        makeProject("p-dash", "/work/pricing/dash", { contextRoot: "/work/pricing" }),
      ],
      (project) => project,
    );
    expect(sections.map((section) => section.label)).toEqual(["pricing", null, "freight"]);
    expect(ids(sections)).toEqual([["p-api", "p-dash"], ["solo"], ["f-model"]]);
  });

  it("treats Windows spellings of one folder as the same section", () => {
    const sections = groupByContextRoot(
      [
        makeProject("one", "C:\\Work\\Freight\\one", { contextRoot: "C:\\Work\\Freight" }),
        makeProject("two", "c:/work/freight/two", { contextRoot: "c:/work/freight/" }),
      ],
      (project) => project,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.label).toBe("Freight");
    expect(ids(sections)).toEqual([["one", "two"]]);
  });

  it("runs over wrapper shapes through the selector", () => {
    const sections = groupByContextRoot(
      [
        { group: makeProject("model", "/work/freight/model", { contextRoot: "/work/freight" }) },
        { group: makeProject("solo", "/work/solo") },
      ],
      (entry) => entry.group,
    );
    expect(sections.map((section) => section.items.map((entry) => entry.group.id))).toEqual([
      ["model"],
      ["solo"],
    ]);
  });
});
