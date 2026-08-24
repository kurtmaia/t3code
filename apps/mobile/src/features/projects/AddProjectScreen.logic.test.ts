import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildDiscoveryCreatePlan, resolveAddProjectEnvironment } from "./AddProjectScreen.logic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function environment(environmentId: EnvironmentId, connectionState: EnvironmentConnectionPhase) {
  return { environmentId, connectionState };
}

describe("resolveAddProjectEnvironment", () => {
  it("does not redirect an explicit unavailable environment to another environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      ),
    ).toBeNull();
  });

  it("resolves an explicit connected environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "connected"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      )?.environmentId,
    ).toBe(ENVIRONMENT_A);
  });

  it("defaults to the first connected environment when no environment is requested", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        null,
      )?.environmentId,
    ).toBe(ENVIRONMENT_B);
  });
});

describe("buildDiscoveryCreatePlan", () => {
  it("plans the parent first and groups each direct-child repository under it", () => {
    const plan = buildDiscoveryCreatePlan({
      rootPath: "/work/freight",
      repositories: [
        { name: "data", path: "/work/freight/data" },
        { name: "model", path: "/work/freight/model" },
      ],
      existingProjects: [],
    });

    expect(plan.map((entry) => entry.title)).toEqual(["freight", "data", "model"]);
    expect(plan.every((entry) => entry.contextRoot === "/work/freight")).toBe(true);
    expect(plan.map((entry) => entry.existingProjectId)).toEqual([null, null, null]);
  });

  it("marks projects that already exist instead of planning duplicate records", () => {
    const modelId = ProjectId.make("model");
    const plan = buildDiscoveryCreatePlan({
      rootPath: "/work/freight/",
      repositories: [{ name: "model", path: "/work/freight/model" }],
      existingProjects: [{ id: modelId, workspaceRoot: "/work/freight/model/" }],
    });

    expect(plan[1]?.existingProjectId).toBe(modelId);
  });
});
