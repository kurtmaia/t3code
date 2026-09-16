import type { ProviderResolvedSkill } from "@t3tools/contracts";

/**
 * Render skills resolved from the shared, cross-provider catalog
 * (`SharedSkillCatalog.ts`) as a single text block, for providers with no
 * dedicated system/developer-instructions channel (Cursor, Grok, OpenCode —
 * see their adapters' `sendTurn`). Prepended ahead of the user's own message
 * so the model sees it as context for the turn, not part of the request.
 */
export function formatResolvedSkillsPromptText(
  resolvedSkills: ReadonlyArray<ProviderResolvedSkill>,
): string {
  const sections = resolvedSkills
    .map((skill) => `### ${skill.name}\n\n${skill.instructions}`)
    .join("\n\n");
  return `The user referenced the following skill(s) with a \`$name\` token. Follow their instructions for this turn as you would a native skill.\n\n${sections}`;
}
