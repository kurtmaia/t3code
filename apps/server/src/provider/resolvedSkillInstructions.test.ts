import { assert, it } from "@effect/vitest";

import { formatResolvedSkillsPromptText } from "./resolvedSkillInstructions.ts";

it("renders each resolved skill under its own heading", () => {
  const text = formatResolvedSkillsPromptText([
    { name: "second-opinion", instructions: "Ask another model to review the diff." },
    { name: "deploy", instructions: "Run the deploy script." },
  ]);

  assert.match(text, /### second-opinion/);
  assert.match(text, /Ask another model to review the diff\./);
  assert.match(text, /### deploy/);
  assert.match(text, /Run the deploy script\./);
});
