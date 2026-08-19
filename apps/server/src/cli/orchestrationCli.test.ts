import { assert, it } from "@effect/vitest";

import { EnvironmentInternalError } from "@t3tools/contracts";

import {
  CliLiveServerDeclaredResponseError,
  CliLiveServerRequestError,
  cliCommandErrorFromLiveServerRequest,
} from "./orchestrationCli.ts";

it("maps declared server failures into structural cli command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = cliCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, CliLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  // The cause can carry credentials, so the message must not be built from it.
  const cause = new Error("credential abc123 was rejected");

  const error = cliCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, CliLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});
