import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

const AZURE_DEVOPS_HOST = "dev.azure.com";

/**
 * The Azure DevOps extension accepts either an AAD token from `az login` or a PAT from
 * `az devops login`, and picks between them itself. Probing `az account show` would only
 * ever see the first, reporting a PAT-authenticated server as signed out, so the probe
 * makes a real Azure DevOps call and lets the extension resolve the credential the same
 * way every other command in this provider does.
 */
function parseAzureAuth(input: SourceControlAuthProbeInput) {
  const output = combinedAuthOutput(input);

  if (input.exitCode === 0) {
    return providerAuth({ status: "authenticated", host: AZURE_DEVOPS_HOST });
  }

  // Without an organization the CLI stops before it reaches a credential, so this failure
  // says nothing about whether the server is signed in.
  if (/--organization must be specified/iu.test(output)) {
    return providerAuth({
      status: "unknown",
      host: AZURE_DEVOPS_HOST,
      detail:
        "No default Azure DevOps organization is configured on this server, so credentials could not be checked. Set one with `az devops configure --defaults organization=https://dev.azure.com/<org>`.",
    });
  }

  return providerAuth({
    status: "unauthenticated",
    host: AZURE_DEVOPS_HOST,
    detail:
      firstSafeAuthLine(output) ??
      "Run `az devops login` to sign in with a personal access token, or `az login` to use an Entra identity.",
  });
}

export const discovery = {
  type: "cli",
  kind: "azure-devops",
  label: "Azure DevOps",
  executable: "az",
  versionArgs: ["--version"],
  // Mirrors the shape of a real provider call so the probe exercises the credential the
  // provider will actually use. `--detect false` keeps it independent of the probe cwd,
  // which is the server root rather than any project.
  authArgs: [
    "devops",
    "project",
    "list",
    "--detect",
    "false",
    "--query",
    "value[0].name",
    "-o",
    "tsv",
    "--only-show-errors",
  ],
  // `az` boots a fresh Python interpreter on every invocation, so even `az --version`
  // takes ~6s on Windows and overruns the default budget, leaving the provider reported
  // as missing on machines where it is installed. `gh` and `glab` answer in ~0.3s.
  probeTimeoutMs: 20_000,
  parseAuth: parseAzureAuth,
  installHint:
    "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlCliDiscoverySpec;

function toChangeRequest(summary: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: ChangeRequest["updatedAt"];
}): ChangeRequest {
  return {
    provider: "azure-devops",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt,
    isCrossRepository: false,
  };
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "azure-devops",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return azure
        .listPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      azure.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "getChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return azure
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          ...(input.target !== undefined ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      azure.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "getRepositoryCloneUrls",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      azure.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      azure.getDefaultBranch({ cwd: input.cwd }).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "azure-devops",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      azure
        .checkoutPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...(input.context !== undefined ? { remoteName: input.context.remoteName } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "azure-devops",
                operation: "checkoutChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
