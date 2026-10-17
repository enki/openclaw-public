import { prepareCommandConversationContext } from "../../../agents/command/conversation-context.js";
import { buildFallbackCandidateTurnParams } from "../../../auto-reply/reply/agent-runner-run-params.js";
import { prepareReplyRunContext } from "../../../auto-reply/reply/get-reply-run-context.js";
import { baseParams } from "../../../auto-reply/reply/get-reply-run.test-support.js";

/** Real producer/composition inputs for native adapter continuity contracts. */
export async function prepareConversationTurnContextContract() {
  const ctx = {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    Provider: "whatsapp",
    Surface: "whatsapp",
    ChatType: "direct",
    From: "+15550001111",
    To: "+15550002222",
    OriginatingChannel: "whatsapp" as const,
    OriginatingTo: "+15550001111",
  };
  const inbound = await prepareReplyRunContext(
    baseParams({ ctx, sessionCtx: ctx, agentId: "main", sessionKey: "agent:main:main" }),
  );
  if (inbound.kind !== "ready") {
    throw new Error("Expected inbound context");
  }
  const composition = buildFallbackCandidateTurnParams({
    turn: {
      followupRun: {
        run: {
          extraSystemPrompt: inbound.extraSystemPromptParts.join("\n\n"),
          extraSystemPromptTurnContext: inbound.extraSystemPromptTurnContext,
        },
      },
      commandBody: "hello",
    },
    currentTurnImages: {},
    bootstrapPromptWarningSignaturesSeen: [],
  } as unknown as Parameters<typeof buildFallbackCandidateTurnParams>[0]);
  // Construct independently: no owner prompt, sender authority, or capability spread.
  const completion = await prepareCommandConversationContext({
    cfg: {},
    sessionKey: "agent:main:main",
    sessionAgentId: "main",
    sessionEntry: {
      sessionId: "synthetic-parent",
      updatedAt: 1,
      chatType: "direct",
      delivery: { kind: "internal" },
    },
    opts: {
      message: "Child settled.",
      privateCompletion: true,
      deliver: false,
      inputProvenance: { kind: "internal_system" },
    },
    runContext: {},
  });
  return { composition, completion };
}
