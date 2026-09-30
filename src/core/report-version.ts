import { appendSummaryVersion, getLog, getRollup, getVersion } from "./entities.ts";
export async function appendReportVersion(
  input: Parameters<typeof appendSummaryVersion>[0],
  signature: string,
) {
  const parent = input.parentKind === "log" ? getLog(input.parentId) : getRollup(input.parentId);
  const active = parent?.activeVersionId ? getVersion(parent.activeVersionId) : null;
  if (active?.chatPrompt?.generationFingerprint === signature) return active;
  return appendSummaryVersion({
    ...input,
    chatPrompt: { ...input.chatPrompt, generationFingerprint: signature },
  });
}
