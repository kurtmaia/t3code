import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

function makeProvider(azure: Partial<AzureDevOpsCli.AzureDevOpsCli["Service"]>) {
  return AzureDevOpsSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)(azure)),
  );
}

it.effect("maps Azure DevOps PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Azure provider",
          url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "azure-devops",
      number: 42,
      title: "Add Azure provider",
      url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: false,
    });
  }),
);

it.effect("adds change-request context while retaining Azure CLI causes", () =>
  Effect.gen(function* () {
    const cause = new AzureDevOpsCli.AzureDevOpsCommandFailedError({
      operation: "execute",
      command: "az",
      cwd: "/repo",
      argumentCount: 2,
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      checkoutPullRequest: () => Effect.fail(cause),
    });

    const error = yield* provider
      .checkoutChangeRequest({ cwd: "/repo", reference: "#42" })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "azure-devops",
        operation: "checkoutChangeRequest",
        command: "az",
        cwd: "/repo",
        reference: "#42",
        detail: "Azure DevOps CLI command failed.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("creates Azure DevOps PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["createPullRequest"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("uses Azure CLI repository detection for default branch lookup", () =>
  Effect.gen(function* () {
    let cwdInput: string | null = null;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        cwdInput = input.cwd;
        return Effect.succeed("main");
      },
    });

    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo" });

    assert.strictEqual(defaultBranch, "main");
    assert.strictEqual(cwdInput, "/repo");
  }),
);

it("reports a PAT-authenticated server as authenticated", () => {
  // `az devops login` leaves no `az account show` identity, so the probe has to read the
  // outcome of a real Azure DevOps call rather than an Entra sign-in.
  const auth = AzureDevOpsSourceControlProvider.discovery.parseAuth({
    stdout: "ds-pricing-engine\n",
    stderr: "",
    exitCode: ChildProcessSpawner.ExitCode(0),
  });

  assert.strictEqual(auth.status, "authenticated");
  assert.deepStrictEqual(auth.host, Option.some("dev.azure.com"));
});

it("stays authenticated when the signed-in organization has no projects", () => {
  const auth = AzureDevOpsSourceControlProvider.discovery.parseAuth({
    stdout: "",
    stderr: "",
    exitCode: ChildProcessSpawner.ExitCode(0),
  });

  assert.strictEqual(auth.status, "authenticated");
});

it("reports unknown rather than unauthenticated when no organization is configured", () => {
  const auth = AzureDevOpsSourceControlProvider.discovery.parseAuth({
    stdout: "",
    stderr:
      "ERROR: --organization must be specified. The value should be the URI of your Azure DevOps organization, for example: https://dev.azure.com/MyOrganization/.",
    exitCode: ChildProcessSpawner.ExitCode(1),
  });

  assert.strictEqual(auth.status, "unknown");
  assert.include(
    Option.getOrElse(auth.detail, () => ""),
    "az devops configure --defaults",
  );
});

it("surfaces the CLI's own dual-credential hint when the call is rejected", () => {
  const auth = AzureDevOpsSourceControlProvider.discovery.parseAuth({
    stdout: "",
    stderr:
      "ERROR: Before you can run Azure DevOps commands, you need to run the login command (az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.",
    exitCode: ChildProcessSpawner.ExitCode(1),
  });

  assert.strictEqual(auth.status, "unauthenticated");
  assert.include(
    Option.getOrElse(auth.detail, () => ""),
    "az devops login",
  );
});

it("probes Azure DevOps itself rather than the Entra sign-in", () => {
  // Regression guard: `az account show` only sees `az login`, so it reported every
  // PAT-authenticated server as signed out.
  assert.deepStrictEqual(AzureDevOpsSourceControlProvider.discovery.authArgs, [
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
  ]);
});
