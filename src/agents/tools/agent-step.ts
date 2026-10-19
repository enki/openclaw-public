import crypto from "node:crypto";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { prepareSessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { TrustedAgentToolCaller } from "../../gateway/server-methods/client-types.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { waitForAgentRunReply } from "../run-wait.js";
import { captureGatewayToolCallerAssertion } from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller as GatewayCaller,
} from "./in-process-gateway.js";
import {
  prepareSessionsSendCommunication,
  readSessionCommunicationEndpoint,
  type SessionSendReplyAdmission,
} from "./sessions-send-communication.js";
import { trySessionsSendActiveRunDelivery } from "./sessions-send-tool.delivery.js";

export type AgentStepSession = {
  sessionId: string;
  lifecycleRevision?: string;
};

export async function runAgentStep(params: {
  agentId?: string;
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  sourceAgentId?: string;
  sourceSessionKey?: string;
  sourceTool?: string;
  sourceRole?: "subagent";
  requester?: TrustedAgentToolCaller;
  callGateway?: GatewayCaller;
  deliveryContext?: DeliveryContext;
  expectedSession?: AgentStepSession;
  expectedSourceSession?: AgentStepSession;
  replyAdmission?: SessionSendReplyAdmission;
}): Promise<void> {
  const promptedAt = Date.now();
  const stepIdem = crypto.randomUUID();
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: params.sourceSessionKey,
    sourceTool: params.sourceTool ?? "sessions_send",
    ...(params.sourceRole ? { sourceRole: params.sourceRole } : {}),
  };
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  const message = annotateInterSessionPromptText(params.message, inputProvenance);
  let communication: Awaited<ReturnType<typeof prepareSessionsSendCommunication>> | undefined;
  if (inputProvenance.sourceTool === "sessions_send") {
    const { agentId, sourceAgentId, sourceSessionKey, expectedSession, expectedSourceSession } =
      params;
    if (
      !agentId ||
      !sourceAgentId ||
      !sourceSessionKey ||
      !expectedSession ||
      !expectedSourceSession ||
      !params.replyAdmission
    ) {
      throw new Error("Returned peer result requires its original source and target sessions.");
    }
    const config = getRuntimeConfig();
    // Detached results retain the original operator's live continuation custody,
    // not the completed tool's lifetime or authority reconstructed from metadata.
    const operatorSource =
      getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
    const assertSourceCurrent = composeSessionSourceAssertion([
      captureGatewayToolCallerAssertion(),
      operatorSource?.assertCurrent,
    ]);
    const load = async (
      endpointAgentId: string,
      sessionKey: string,
      expected: AgentStepSession,
    ) => {
      const endpoint = await readSessionCommunicationEndpoint({
        config,
        endpoint: { agentId: endpointAgentId, sessionKey, storePath: "" },
        assertCurrent: assertSourceCurrent,
      });
      if (
        endpoint.agentId !== endpointAgentId ||
        endpoint.sessionKey !== sessionKey ||
        endpoint.entry?.sessionId !== expected.sessionId ||
        endpoint.entry.lifecycleRevision !== expected.lifecycleRevision ||
        endpoint.entry.archivedAt !== undefined
      ) {
        throw new Error("Returned peer result session changed before admission.");
      }
      return endpoint;
    };
    const [source, target] = await Promise.all([
      load(sourceAgentId, sourceSessionKey, expectedSourceSession),
      load(agentId, params.sessionKey, expectedSession),
    ]);
    communication = await prepareSessionsSendCommunication({
      config,
      source,
      target,
      message: params.message,
      dispatchMessage: message,
      inputProvenance,
      allowApproval: false,
      acceptedReply: params.replyAdmission,
      assertSourceCurrent,
      signal: operatorSource?.signal,
      callGateway: gatewayCall,
    });
  }
  let response: Record<string, unknown> | undefined;
  let steered = false;
  try {
    if (params.sourceRole !== "subagent" && isSessionRunActiveForKey(params.sessionKey)) {
      const cfg = communication?.admissionConfig ?? getRuntimeConfig();
      communication?.assertCurrent();
      const agentId =
        params.agentId ?? resolveSessionAgentId({ config: cfg, sessionKey: params.sessionKey });
      const target = await resolveGatewaySessionStoreTargetInWorker({
        cfg,
        key: params.sessionKey,
        agentId,
        assertActive: communication?.assertCurrent,
      });
      const entry = target.store[target.canonicalKey];
      if (!entry?.sessionId) {
        throw new Error("Requester session no longer exists.");
      }
      const generation = await prepareSessionDeliveryGeneration({
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKey: target.canonicalKey,
        sessionId: params.expectedSession?.sessionId ?? entry.sessionId,
        lifecycleRevision: params.expectedSession
          ? (params.expectedSession.lifecycleRevision ?? null)
          : (entry.lifecycleRevision ?? null),
      });
      let accepted = false;
      try {
        const result = await trySessionsSendActiveRunDelivery(
          {
            cfg,
            admissionConfig: communication?.admissionConfig ?? cfg,
            callGateway: communication?.callGateway ?? gatewayCall,
            runId: stepIdem,
            sessionKey: target.canonicalKey,
            sessionStoreTarget: target,
            expectedSessionId: params.expectedSession?.sessionId ?? entry.sessionId,
            recipientGeneration: generation,
            transcriptText: message,
            onQueueAccepted: (value) => {
              accepted ||= value;
            },
            assertSendCurrent: communication?.assertCurrent,
            allowActiveRunQueueDelivery: true,
            deliveryTimeoutMs: Math.min(params.timeoutMs, 10_000),
            sendParams: {
              // Active input cannot change the running turn's system prompt. Carry
              // the returned-result instructions with this attributed input instead.
              message: annotateInterSessionPromptText(
                `${params.extraSystemPrompt}\n\n${params.message}`,
                inputProvenance,
              ),
              agentId: target.agentId,
              inputProvenance,
              sourceReplyDeliveryMode: "message_tool_only",
            },
          },
          false,
        );
        if ("ok" in result) {
          if (!result.ok) {
            const details = result.result.details as { error?: string };
            throw new Error(details.error ?? "Requester result steering failed.");
          }
          steered = result.targetDisposition === "steered";
          accepted ||= steered;
        }
      } finally {
        if (!accepted) {
          generation.release();
        }
      }
    }
    if (!steered) {
      response = await (communication?.callGateway ?? gatewayCall)({
        method: "agent",
        // This is a returned result, not a new request to the peer. Consuming it
        // must not require an acknowledgment or repeat an already delivered final.
        replyExpectation: "optional",
        agentToolCaller: params.requester,
        params: {
          message,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          sessionKey: params.sessionKey,
          deliver: false,
          sourceReplyDeliveryMode: "message_tool_only",
          channel: params.deliveryContext?.channel ?? INTERNAL_MESSAGE_CHANNEL,
          lane: resolveNestedAgentLaneForSession(params.sessionKey),
          extraSystemPrompt: params.extraSystemPrompt,
          inputProvenance,
          idempotencyKey: stepIdem,
          expectedExistingSessionId: params.expectedSession?.sessionId,
          expectedExistingSessionLifecycleRevision: params.expectedSession
            ? (params.expectedSession.lifecycleRevision ?? null)
            : undefined,
          accountId: params.deliveryContext?.accountId,
          to: params.deliveryContext?.to,
          threadId: stringifyRouteThreadId(params.deliveryContext?.threadId),
        },
        timeoutMs: 10_000,
      });
    }
  } finally {
    communication?.close();
  }

  if (params.sourceAgentId && params.agentId) {
    recordSessionParticipantBestEffort({
      identity: { type: "agent", id: params.sourceAgentId },
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
        agentId: params.agentId,
      }),
      promptedAt,
    });
  }

  if (steered) {
    return;
  }
  const resolvedRunId =
    typeof response?.runId === "string" && response.runId ? response.runId : stepIdem;
  const result = await waitForAgentRunReply({
    runId: resolvedRunId,
    timeoutMs: Math.min(params.timeoutMs, 60_000),
    callGateway: gatewayCall,
    untilTerminal: true,
  });
  if (result.status !== "ok") {
    throw new Error(result.error ?? `Requester continuation ended with ${result.status}.`);
  }
}
