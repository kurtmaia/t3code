import * as NodeServices from "@effect/platform-node/NodeServices";
import { CopilotSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
} from "./CopilotProvider.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

describe("buildInitialCopilotProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCopilotProviderSnapshot(decodeCopilotSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCopilotProviderSnapshot(
        decodeCopilotSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Checking GitHub Copilot");
    }),
  );
});

it.layer(NodeServices.layer)("checkCopilotProviderStatus", (it) => {
  it.effect("reports a missing CLI without starting ACP", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCopilotProviderStatus(
        decodeCopilotSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/copilot-binary",
        }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("not installed");
    }),
  );
});
