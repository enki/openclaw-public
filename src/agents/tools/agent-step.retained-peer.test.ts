// Retained requester results exercise real storage, communication and continuation owners.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageInjectionAcceptedUnconfirmedError } from "../../auto-reply/reply/message-injection-authority.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { projectForwardedMessages } from "../../gateway/chat-display-projection.history.js";
import { captureGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import type {
  EmbeddedAgentQueueHandle,
  EmbeddedAgentQueueMessageOptions,
} from "../embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../harness/tool-authority.runtime.js";
import { captureRequesterOrigin } from "../requester-origin.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import * as gatewayContinuation from "./in-process-gateway.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import {
  prepareSessionsSendCommunication,
  readSessionCommunicationEndpoint,
} from "./sessions-send-communication.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

describe("returned peer results", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
  });
  it.each(["accepted", "unconfirmed", "replaced", "lifecycle-changed"] as const)(
    "delivers a completed peer result to the busy requester (%s)",
    async (outcome) => {
      await withOpenClawTestState(
        { scenario: "minimal", prepareProfileCatalog: true },
        async () => {
          const cfg: OpenClawConfig = {
            tools: { sessions: { visibility: "all" } },
            session: { communication: { send: "always", receive: "always" } },
          };
          setRuntimeConfigSnapshot(cfg);
          const sessionKey = "agent:main:dashboard:synthetic-requester";
          const sessionId = "synthetic-requester-session";
          const scope = { agentId: "main", sessionKey, sessionId };
          const requesterSession = { sessionId, lifecycleRevision: "requester-v1", updatedAt: 1 };
          const peerSessionKey = "agent:main:dashboard:synthetic-peer";
          const peerSession = {
            sessionId: "synthetic-peer-session",
            lifecycleRevision: "peer-v1",
            updatedAt: 1,
          };
          const peerRunId = "synthetic-completed-peer-run";
          await replaceSessionEntry(scope, requesterSession);
          await replaceSessionEntry({ agentId: "main", sessionKey: peerSessionKey }, peerSession);
          const owner = createOperatorClient({
            profileName: "peer-steering-owner",
            scopes: ["operator.read", "operator.write"],
          });
          const context = createContext([], () => cfg);
          const resolveGatewayContext = () => context;
          context.resolveGatewayContext = resolveGatewayContext;
          let connected = true;
          let receiptCurrent = true;
          const device = captureGatewayDeviceRevocation(
            context,
            { deviceId: "peer-steering-device", role: "operator" },
            () => connected,
            undefined,
            { isCurrent: () => true, subscribe: () => () => {} },
          );
          const source = await captureGatewayOperatorRunAuthority({
            client: owner,
            context,
            hasCurrentClientAuthority: device.isCurrent,
          });
          const origin = captureRequesterOrigin({
            sessionKey,
            operatorProfileId: owner.authenticatedUserProfile?.profileId,
          });
          if (!source || !origin) {
            throw new Error("Expected the real admitted peer requester source");
          }
          const entered = createDeferredCore();
          const finishPeer = createDeferredCore();
          const forwarded = createDeferredCore();
          const gatewayCalls: Parameters<AgentToolGatewayRequestCaller>[0][] = [];
          const callGateway: AgentToolGatewayRequestCaller = async <T>(
            request: Parameters<AgentToolGatewayRequestCaller>[0],
          ): Promise<T> => {
            gatewayCalls.push(request);
            if (request.method === "agent.wait") {
              entered.resolve();
              await finishPeer.promise;
              return {
                status: "ok",
                terminalReply: { disposition: "visible", text: "Synthetic peer result" },
              } as T;
            }
            if (
              request.method === "agent" &&
              isRecord(request.params) &&
              request.params.sessionKey === peerSessionKey
            ) {
              expect(request.params.idempotencyKey).toBe(peerRunId);
              request.sessionMutationCommitGuard?.();
              request.assertDispatchCurrent?.();
              return { runId: peerRunId } as T;
            }
            return { runId: "synthetic-unwanted-next-turn" } as T;
          };
          let queued: EmbeddedAgentQueueMessageOptions | undefined;
          const queueMessage = vi.fn(
            async (_text: string, options?: EmbeddedAgentQueueMessageOptions) => {
              queued = options;
              options?.onQueueAccepted?.(true);
              if (outcome === "unconfirmed") {
                throw new MessageInjectionAcceptedUnconfirmedError();
              }
            },
          );
          const handle: EmbeddedAgentQueueHandle = {
            runId: "synthetic-active-requester-run",
            queueMessage,
            isStreaming: () => true,
            isCompacting: () => false,
            abort: () => {},
            sourceReplyDeliveryMode: "automatic",
            messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
          };
          const admission = prepareAgentRunAdmission({
            cfg,
            operationalRunInstance: createOperationalRunInstanceRef(handle.runId!),
            operatorAuthority: source.authority,
            facts: {
              agentId: "main",
              runId: handle.runId!,
              ingress: { kind: "system", state: "present", boundary: "peer-steering-test" },
            },
          });
          try {
            await withPreparedEmbeddedRunToolAuthority(
              { admittedRunContext: await admission.admit("embedded", "peer-steering-test") },
              {
                ...scope,
                runId: handle.runId!,
                sessionFile: "/tmp/peer-steering-test.jsonl",
                workspaceDir: "/tmp/peer-steering-test",
                config: cfg,
                provider: "openai",
                modelId: "gpt-test",
                requesterOrigin: origin,
              },
              undefined,
              async (prepared) => {
                handle.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
                setActiveEmbeddedRun(
                  sessionId,
                  handle,
                  sessionKey,
                  "/tmp/peer-steering-test.jsonl",
                  "main",
                  prepared.replyOperation,
                );
                let retained: ReturnType<typeof resolveGatewayToolOperatorSelection> | undefined;
                const continuation = gatewayContinuation.runWithGatewayToolContinuationContext;
                const observed = vi
                  .spyOn(gatewayContinuation, "runWithGatewayToolContinuationContext")
                  .mockImplementation(
                    async <T>(
                      run: () => Promise<T>,
                      options?: { retainRequester?: true },
                    ): Promise<T> => {
                      try {
                        return await continuation(async () => {
                          retained = resolveGatewayToolOperatorSelection();
                          expect(
                            getGatewayToolCallerIdentity()?.operationalRunInstance,
                          ).toBeUndefined();
                          expect(getGatewayToolCallerIdentity()?.receiptAuthority).toBeUndefined();
                          expect(getGatewayToolCallerIdentity()?.fullPermission).toBeUndefined();
                          return run();
                        }, options);
                      } finally {
                        forwarded.resolve();
                      }
                    },
                  );
                try {
                  await withPluginRuntimeGatewayRequestScope(
                    {
                      client: owner,
                      context,
                      resolveGatewayContext,
                      isWebchatConnect: () => false,
                      hasCurrentClientAuthority: device.isCurrent,
                    },
                    () =>
                      withOperatorToolGatewayAuthority({ scopes: owner.connect.scopes ?? [] }, () =>
                        withGatewayToolCallerIdentity(
                          {
                            agentId: "main",
                            sessionKey,
                            requesterOrigin: origin,
                            operatorAuthority: source.authority,
                            operationalRunInstance:
                              createOperationalRunInstanceRef("ended-peer-tool"),
                            receiptAuthority: () => receiptCurrent,
                            fullPermission: true,
                          },
                          async () => {
                            const inputProvenance = {
                              kind: "inter_session" as const,
                              sourceTool: "sessions_send",
                              sourceSessionKey: sessionKey,
                            };
                            const [requesterEndpoint, peerEndpoint] = await Promise.all([
                              readSessionCommunicationEndpoint({
                                config: cfg,
                                endpoint: { agentId: "main", sessionKey, storePath: "" },
                                assertCurrent: () => source.authority.assertCurrent(),
                              }),
                              readSessionCommunicationEndpoint({
                                config: cfg,
                                endpoint: {
                                  agentId: "main",
                                  sessionKey: peerSessionKey,
                                  storePath: "",
                                },
                                assertCurrent: () => source.authority.assertCurrent(),
                              }),
                            ]);
                            expect(requesterEndpoint.entry).toMatchObject(requesterSession);
                            expect(peerEndpoint.entry).toMatchObject(peerSession);
                            const original = await prepareSessionsSendCommunication({
                              config: cfg,
                              source: requesterEndpoint,
                              target: peerEndpoint,
                              message: "Synthetic peer request",
                              inputProvenance,
                              assertSourceCurrent: () => source.authority.assertCurrent(),
                              callGateway,
                            });
                            try {
                              expect(() => original.captureReplyAdmission(peerRunId)).toThrow(
                                "no accepted source request",
                              );
                              await original.callGateway({
                                method: "agent",
                                params: {
                                  agentId: "main",
                                  sessionKey: peerSessionKey,
                                  message: "Synthetic peer request",
                                  inputProvenance,
                                  idempotencyKey: peerRunId,
                                },
                              });
                              const replyAdmission = original.captureReplyAdmission(peerRunId);
                              await startSessionsSendReplyFlow({
                                skip: false,
                                callGateway,
                                targetSessionKey: peerSessionKey,
                                targetSession: peerSession,
                                replyAdmission,
                                targetAgentId: "main",
                                displayKey: "synthetic-peer",
                                runId: peerRunId,
                                replyTimeoutMs: 1_000,
                                replyMode: "peer",
                                requesterSessionKey: sessionKey,
                                requesterAgentId: "main",
                                requesterSession: {
                                  sessionId:
                                    outcome === "replaced"
                                      ? "retired-requester-session"
                                      : sessionId,
                                  lifecycleRevision:
                                    outcome === "lifecycle-changed"
                                      ? "retired-lifecycle"
                                      : requesterSession.lifecycleRevision,
                                },
                              });
                              await entered.promise;
                            } finally {
                              original.close();
                            }
                          },
                        ),
                      ),
                  );
                  // The sender's receipt, invocation and transport end before the peer result arrives.
                  receiptCurrent = false;
                  connected = false;
                  source.release();
                  device.release();
                  finishPeer.resolve();
                  await forwarded.promise;
                  expect(gatewayCalls.map((call) => call.method)).toEqual(["agent", "agent.wait"]);
                  if (outcome === "replaced" || outcome === "lifecycle-changed") {
                    expect(queueMessage).not.toHaveBeenCalled();
                    expect(await loadTranscriptEvents(scope)).toEqual([]);
                    return;
                  }
                  expect(queueMessage).toHaveBeenCalledOnce();
                  expect(retained?.assertCurrent).toThrow();
                  expect(queued?.waitForTranscriptCommit).toBe(false);
                  expect(await loadTranscriptEvents(scope)).toEqual([]);
                  const recorder = queued?.userTurnTranscriptRecorder;
                  if (!recorder) {
                    throw new Error("Receiver lost its admitted input recorder");
                  }
                  // The accepting receiver owns this receipt after forwarding custody is released.
                  const persisted = await recorder.persistApproved();
                  expect(persisted?.message.provenance).toMatchObject({
                    kind: "inter_session",
                    sourceTool: "sessions_send",
                    sourceSessionKey: "agent:main:dashboard:synthetic-peer",
                  });
                  expect(JSON.stringify(persisted?.message.content)).toContain(
                    "Synthetic peer result",
                  );
                  expect(queueMessage.mock.calls[0]?.[0]).toContain(
                    "This result is delivered once",
                  );
                  expect(queueMessage.mock.calls[0]?.[0]).toContain("will not be sent back");
                  expect(projectForwardedMessages([{ ...persisted?.message }])[0]).toMatchObject({
                    role: "assistant",
                    content: "Synthetic peer result",
                    senderLabel: expect.stringContaining("Forwarded"),
                    senderSession: { sessionKey: "agent:main:dashboard:synthetic-peer" },
                  });
                  expect(persisted?.message.idempotencyKey).toBeTruthy();
                  queued?.onQueueSettled?.();
                  expect(
                    (await loadTranscriptEvents(scope)).filter(
                      (entry) => isRecord(entry) && entry.type === "message",
                    ),
                  ).toHaveLength(1);
                  expect(gatewayCalls.map((call) => call.method)).toEqual(["agent", "agent.wait"]);
                  if (outcome === "unconfirmed") {
                    expect(recordParticipant).not.toHaveBeenCalled();
                  } else {
                    expect(recordParticipant).toHaveBeenCalledOnce();
                  }
                } finally {
                  observed.mockRestore();
                  finishPeer.resolve();
                  queued?.onQueueSettled?.();
                  clearActiveEmbeddedRun(sessionId, handle, sessionKey);
                }
              },
            );
          } finally {
            admission.close();
            source.release();
            device.release();
          }
        },
      );
    },
  );
});
