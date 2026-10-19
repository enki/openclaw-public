// Agent step tests cover nested session handoff and
// MCP runtime survival after completed nested turns.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageInjectionAcceptedUnconfirmedError } from "../../auto-reply/reply/message-injection-authority.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
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
import { runAgentStep } from "./agent-step.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import * as gatewayContinuation from "./in-process-gateway.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

const agentWaitMock = vi.hoisted(() => vi.fn());

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

vi.mock("../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

describe("runAgentStep", () => {
  afterEach(() => {
    agentWaitMock.mockReset();
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
  });

  it("surfaces a failed accepted requester continuation without redispatching the peer result", async () => {
    const failure = "Codex thread synthetic-thread is claimed by active work; stop it first.";
    const gatewayCalls: CallGatewayOptions[] = [];
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
      gatewayCalls.push(opts);
      if (opts.method === "agent") {
        return { runId: "accepted-requester-run" } as T;
      }
      if (opts.method === "agent.wait") {
        return { status: "error", error: failure, endedAt: 1234 } as T;
      }
      throw new Error(`Unexpected Gateway request: ${opts.method}`);
    };

    await expect(
      runSessionsSendA2AFlow({
        callGateway,
        targetSessionKey: "agent:main:peer",
        targetAgentId: "main",
        displayKey: "peer",
        runId: "completed-peer-run",
        replyTimeoutMs: 10_000,
        requesterSessionKey: "agent:main:requester",
        reply: {
          status: "ok",
          replyText: "Synthetic peer result",
          terminalReply: { disposition: "visible", text: "Synthetic peer result" },
        },
        deliverRequesterReply: (reply) =>
          runAgentStep({
            ...reply,
            sessionKey: "agent:main:requester",
            timeoutMs: 10_000,
            callGateway,
          }),
      }),
    ).rejects.toThrow(failure);
    expect(gatewayCalls.map((call) => call.method)).toEqual(["agent", "agent.wait"]);
  });

  it("preserves bundle MCP runtime after successful nested agent steps", async () => {
    // Nested steps disable automatic delivery and carry provenance so the reply
    // returns through the message tool path instead of the channel.
    const gatewayCalls: CallGatewayOptions[] = [];
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
      if (opts.method === "agent.wait") {
        return await agentWaitMock(opts);
      }
      gatewayCalls.push(opts);
      return { runId: "run-nested" } as T;
    };
    agentWaitMock.mockResolvedValue({
      status: "ok",
      terminalReply: { disposition: "visible", text: "done" },
    });
    setRuntimeConfigSnapshot({});

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        agentId: "main",
        sourceAgentId: "research",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).resolves.toBeUndefined();

    expect(gatewayCalls[0]).toMatchObject({ replyExpectation: "optional" });
    const params = gatewayCalls[0]?.params as
      | {
          message?: string;
          sessionKey?: string;
          deliver?: boolean;
          sourceReplyDeliveryMode?: string;
          lane?: string;
          inputProvenance?: { kind?: string; sourceTool?: string };
        }
      | undefined;
    expect(params?.message).toContain("[Inter-session message");
    expect(params?.sessionKey).toBe("agent:main:subagent:child");
    expect(params?.deliver).toBe(false);
    expect(params?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(params?.lane).toBe("nested:agent:main:subagent:child");
    expect(params?.inputProvenance?.kind).toBe("inter_session");
    expect(params?.inputProvenance?.sourceTool).toBe("sessions_send");
    expect(params?.message).toContain("isUser=false");
    expect(params?.message).toContain("hello");
    expect(recordParticipant).toHaveBeenCalledOnce();
    expect(recordParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { type: "agent", id: "research" },
        agentId: "main",
        sessionKey: "agent:main:subagent:child",
        promptedAt: expect.any(Number),
      }),
    );
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("waits for the nested reply through queued and nonterminal timeout observations", async () => {
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> =>
      opts.method === "agent.wait" ? await agentWaitMock(opts) : ({ runId: "run-pending" } as T);
    agentWaitMock
      .mockResolvedValueOnce({ status: "pending", timeoutPhase: "queue" })
      .mockResolvedValueOnce({ status: "timeout" })
      .mockResolvedValueOnce({
        status: "ok",
        terminalReply: { disposition: "visible", text: "late reply" },
      });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).resolves.toBeUndefined();
    expect(agentWaitMock).toHaveBeenCalledTimes(3);

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });
});

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
          const cfg = {};
          setRuntimeConfigSnapshot(cfg);
          const sessionKey = "agent:main:dashboard:synthetic-requester";
          const sessionId = "synthetic-requester-session";
          const scope = { agentId: "main", sessionKey, sessionId };
          await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
          const owner = createOperatorClient({
            profileName: "peer-steering-owner",
            scopes: ["operator.read", "operator.write"],
          });
          const context = createContext();
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
          const gatewayCalls: CallGatewayOptions[] = [];
          const callGateway = async <T = unknown>(request: CallGatewayOptions): Promise<T> => {
            gatewayCalls.push(request);
            if (request.method === "agent.wait") {
              entered.resolve();
              await finishPeer.promise;
              return {
                status: "ok",
                terminalReply: { disposition: "visible", text: "Synthetic peer result" },
              } as T;
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
                            await startSessionsSendReplyFlow({
                              skip: false,
                              callGateway,
                              targetSessionKey: "agent:main:dashboard:synthetic-peer",
                              targetAgentId: "main",
                              displayKey: "synthetic-peer",
                              runId: "synthetic-completed-peer-run",
                              replyTimeoutMs: 1_000,
                              replyMode: "peer",
                              requesterSessionKey: sessionKey,
                              requesterAgentId: "main",
                              requesterSession: {
                                sessionId:
                                  outcome === "replaced" ? "retired-requester-session" : sessionId,
                                ...(outcome === "lifecycle-changed"
                                  ? { lifecycleRevision: "retired-lifecycle" }
                                  : {}),
                              },
                            });
                            await entered.promise;
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
                  expect(gatewayCalls.map((call) => call.method)).toEqual(["agent.wait"]);
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
                  expect(gatewayCalls.map((call) => call.method)).toEqual(["agent.wait"]);
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
