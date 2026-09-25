import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupByEnvironment, projectsSpanMultipleEnvironments } from "./sidebarProjectGrouping";

const local = EnvironmentId.make("local");
const devbox = EnvironmentId.make("devbox");
const wsl = EnvironmentId.make("wsl");

describe("projectsSpanMultipleEnvironments", () => {
  it("is false for zero or one environment", () => {
    expect(projectsSpanMultipleEnvironments([])).toBe(false);
    expect(
      projectsSpanMultipleEnvironments([{ environmentId: local }, { environmentId: local }]),
    ).toBe(false);
  });

  it("is true once a second environment appears", () => {
    expect(
      projectsSpanMultipleEnvironments([{ environmentId: local }, { environmentId: devbox }]),
    ).toBe(true);
  });
});

describe("groupByEnvironment", () => {
  const labels = new Map([
    [devbox, "devbox"],
    [wsl, "Alpine"],
  ]);

  it("puts the primary environment first, then the rest by label, keeping item order", () => {
    const items = [
      { id: "a", environmentId: devbox },
      { id: "b", environmentId: local },
      { id: "c", environmentId: wsl },
      { id: "d", environmentId: devbox },
      { id: "e", environmentId: local },
    ];
    const sections = groupByEnvironment(items, (item) => item.environmentId, {
      primaryEnvironmentId: local,
      resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    });
    expect(
      sections.map((section) => [section.label, section.isPrimary, section.items.map((i) => i.id)]),
    ).toEqual([
      ["This device", true, ["b", "e"]],
      ["Alpine", false, ["c"]],
      ["devbox", false, ["a", "d"]],
    ]);
  });
});
