import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  inferProjectTitleFromPath,
  normalizeProjectPathForComparison,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, FilesystemDiscoveredRepository, ProjectId } from "@t3tools/contracts";

export interface DiscoveryCreatePlanEntry {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly contextRoot: string;
  readonly existingProjectId: ProjectId | null;
}

export function buildDiscoveryCreatePlan(input: {
  readonly rootPath: string;
  readonly repositories: ReadonlyArray<FilesystemDiscoveredRepository>;
  readonly existingProjects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): ReadonlyArray<DiscoveryCreatePlanEntry> {
  const existingByPath = new Map(
    input.existingProjects.map((project) => [
      normalizeProjectPathForComparison(project.workspaceRoot),
      project.id,
    ]),
  );
  return [
    {
      title: inferProjectTitleFromPath(input.rootPath),
      workspaceRoot: input.rootPath,
    },
    ...input.repositories.map((repository) => ({
      title: repository.name,
      workspaceRoot: repository.path,
    })),
  ].map((project) => ({
    ...project,
    contextRoot: input.rootPath,
    existingProjectId:
      existingByPath.get(normalizeProjectPathForComparison(project.workspaceRoot)) ?? null,
  }));
}

export function resolveAddProjectEnvironment<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  },
>(environmentOptions: ReadonlyArray<T>, requestedEnvironmentId: EnvironmentId | null): T | null {
  if (requestedEnvironmentId !== null) {
    return (
      environmentOptions.find(
        (environment) =>
          environment.environmentId === requestedEnvironmentId &&
          canCreateProjectInEnvironment(environment.connectionState),
      ) ?? null
    );
  }

  return (
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ?? null
  );
}
