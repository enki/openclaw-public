import { afterEach, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getSessionControllerOperation } from "../sessions/session-controller.js";
import * as controllerSteer from "../sessions/session-controller.steer.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import {
  detachActiveEmbeddedRun as clearActiveEmbeddedRun,
  attachActiveEmbeddedRun as setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
} from "./embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "./embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./harness/tool-authority.runtime.js";
import { captureRequesterOrigin } from "./requester-origin.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import * as sessionsSendFollowup from "./tools/sessions-send-followup-custody.js";
import type { createSessionsSendTool } from "./tools/sessions-send-tool.js";

export function createSessionsSendTestCaller(sessionKey = "agent:re-portal:main") {
  const requesterOrigin = captureRequesterOrigin({
    sessionKey,
    messageProvider: "telegram",
    senderId: "sessions-requester",
  });
  if (!requesterOrigin) {
    throw new Error("sessions-send fixture requires a requester session");
  }
  return {
    agentId: parseAgentSessionKey(sessionKey)?.agentId ?? "main",
    sessionKey,
    requesterOrigin,
  };
}

export function createDurableSessionsSendTestRun(runId: string, afterCommit?: () => Promise<void>) {
  const queueMessage = vi.fn<EmbeddedAgentQueueHandle["queueMessage"]>(async (_text, options) => {
    const recorder = options?.userTurnTranscriptRecorder;
    if (!recorder || !(await recorder.persistApproved())) {
      throw new Error("Steering fixture did not commit the admitted guidance");
    }
    await afterCommit?.();
  });
  const handle = createEmbeddedRunHandle({
    runId,
    queueMessage,
    supportsTranscriptCommitWait: true,
  });
  handle.messageInjectionV2 = {
    version: 2,
    isAvailable: () => true,
    queueMessage: async (text, options, assertCurrent) => {
      assertCurrent();
      await queueMessage(text, options);
      options?.onQueueAccepted?.(true);
    },
  };
  return { handle, queueMessage };
}

const activeOwners: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(activeOwners.splice(0).map((close) => close()));
});

/** Publish through the same admitted attempt owner as the runtime under test. */
export async function setSessionsSendTestActiveRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey: string,
  requesterSessionKey: string | undefined,
  config: OpenClawConfig,
  storeScope?: string,
) {
  const caller = createSessionsSendTestCaller(requesterSessionKey);
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? "main";
  const storePath = storeScope ?? resolveSessionStorePathCore(config.session?.store, { agentId });
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    agentId,
    incarnation: sessionId,
  });
  const operation = getSessionControllerOperation(sessionKey, target);
  const runId = handle.runId ?? `sessions-target:${sessionId}`;
  const sessionFile = `/tmp/${sessionId}.jsonl`;
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId,
      runId,
      ingress: { kind: "system", state: "present", boundary: "sessions-send-test" },
    },
  });
  const ready = createDeferred();
  const closed = createDeferred();
  const completion = (async () => {
    try {
      await withPreparedEmbeddedRunToolAuthority(
        {
          admittedRunContext: await admission.admit("embedded", "sessions-send-test"),
          replyOperation: operation,
        },
        {
          sessionId,
          sessionKey,
          runId,
          agentId,
          sessionFile,
          sessionTarget: { agentId, sessionId, sessionKey, storePath },
          workspaceDir: "/tmp/sessions-send-test",
          config,
          provider: "openai",
          modelId: "gpt-test",
          requesterOrigin: caller.requesterOrigin,
        },
        undefined,
        async (prepared) => {
          handle.runId = runId;
          handle.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
          setActiveEmbeddedRun(
            sessionId,
            handle,
            sessionKey,
            sessionFile,
            agentId,
            prepared.replyOperation,
          );
          ready.resolve();
          await closed.promise;
        },
      );
    } catch (error) {
      ready.reject(error);
      throw error;
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      admission.close();
    }
  })();
  // The owner stays open through the test; cleanup joins any late failure.
  void completion.catch(() => {});
  const close = async () => {
    closed.resolve();
    await completion;
  };
  activeOwners.push(close);
  await ready.promise;
  return close;
}

export async function activeRun(
  sessionKey: string,
  options: {
    config: OpenClawConfig;
    sessionId?: string;
    storeScope?: string;
    requesterSessionKey?: string;
    streaming?: boolean;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    rejects?: boolean;
    abort?: () => void;
  },
) {
  const queueMessage = vi.fn(async (_text: string, _options?: EmbeddedAgentQueueMessageOptions) => {
    if (options.rejects) {
      throw new Error("active session ended before queued steering message was committed");
    }
    const recorder = _options?.userTurnTranscriptRecorder;
    if (!recorder || !(await recorder.persistApproved())) {
      throw new Error("Steering fixture did not commit the admitted guidance");
    }
  });
  await setSessionsSendTestActiveRun(
    options.sessionId ?? "caller-active-session",
    {
      queueMessage,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => options.streaming ?? true,
        queueMessage: async (text, queueOptions, assertCurrent) => {
          assertCurrent();
          await queueMessage(text, queueOptions);
          queueOptions?.onQueueAccepted?.(true);
        },
      },
      isStreaming: () => options.streaming ?? true,
      isStopped: () => options.streaming === false,
      isCompacting: () => false,
      supportsTranscriptCommitWait: true,
      sourceReplyDeliveryMode: options.sourceReplyDeliveryMode ?? "message_tool_only",
      abort: options.abort ?? (() => {}),
    },
    sessionKey,
    options.requesterSessionKey,
    options.config,
    options.storeScope,
  );
  return queueMessage;
}

function withTestRequester(tool: AnyAgentTool, sessionKey: string): AnyAgentTool {
  return {
    ...tool,
    execute: (...args) =>
      withGatewayToolCallerIdentity(createSessionsSendTestCaller(sessionKey), () =>
        tool.execute(...args),
      ),
  };
}

type SessionsSendSteeringFixtures = {
  getSessionTool: (
    name: "sessions_send",
    options: { agentSessionKey: string; agentChannel?: string; config?: OpenClawConfig },
  ) => AnyAgentTool;
  seedSession: (sessionKey: string, sessionId?: string) => Promise<void>;
  callGatewayMock: Mock<
    (request: { method?: string; params?: Record<string, unknown> }) => Promise<unknown>
  >;
  mockGatewayResponses: (responses: Record<string, unknown>) => void;
  settleContinuations: () => Promise<void>;
  cloneTestConfig: () => OpenClawConfig;
};

export function registerSessionsSendRejectedSteeringTests({
  getSessionTool: createSessionTool,
  seedSession,
  callGatewayMock,
  mockGatewayResponses,
  settleContinuations,
  cloneTestConfig,
}: SessionsSendSteeringFixtures) {
  const getSessionTool: SessionsSendSteeringFixtures["getSessionTool"] = (name, options) =>
    withTestRequester(createSessionTool(name, options), options.agentSessionKey);

  it.each([
    {
      name: "runtime rejection",
      key: "agent:leasing-ops:cron:monthly-utility:run:run-fast",
      rejects: true,
      reason: "runtime_rejected",
    },
    {
      name: "captured automatic reply owner",
      key: "agent:leasing-ops:cron:monthly-utility:run:run-fast",
      deliveryMode: "automatic" as const,
      disposition: "steered" as const,
    },
    {
      name: "non-Cron run-looking key",
      key: "agent:leasing-ops:slack:channel:c-room:run:run-fast",
      streaming: false,
      disposition: "queued" as const,
    },
  ])(
    "sessions_send preserves the captured target for $name",
    async ({ key, rejects, deliveryMode, streaming, reason, disposition }) => {
      await seedSession("agent:re-portal:main");
      await seedSession(key, "caller-active-session");
      const queueMessage = await activeRun(key, {
        config: cloneTestConfig(),
        rejects,
        streaming,
        sourceReplyDeliveryMode: deliveryMode,
      });
      mockGatewayResponses({
        agent: { runId: "fallback-run", status: "accepted", acceptedAt: 2000 },
      });
      const result = await getSessionTool("sessions_send", {
        agentSessionKey: "agent:re-portal:main",
        agentChannel: "telegram",
        config: cloneTestConfig(),
      }).execute("active-send", {
        sessionKey: key,
        message: "[TASK-COMPLETE] occupancy ready",
        timeoutSeconds: 0,
      });
      expect(result.details).toMatchObject(
        disposition
          ? { status: "accepted", sessionKey: key, targetDisposition: disposition }
          : {
              status: "error",
              sessionKey: key,
              error: expect.stringContaining(`queue_message_failed reason=${reason}`),
            },
      );
      const admissions = callGatewayMock.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(admissions).toHaveLength(disposition === "queued" ? 1 : 0);
      if (disposition === "queued") {
        expect(result.details).toHaveProperty("runId", "fallback-run");
        expect(admissions[0]?.[0].params).toMatchObject({
          sessionKey: key,
          agentId: "leasing-ops",
          sourceReplyDeliveryMode: "message_tool_only",
        });
      }
      if (rejects) {
        expect(result.details).toHaveProperty(
          "error",
          expect.stringContaining("caller-active-session"),
        );
        expect(result.details).toHaveProperty(
          "error",
          expect.not.stringContaining("fallback_failed"),
        );
        const queuedText = queueMessage.mock.calls[0]?.[0];
        expect(queuedText).toContain("[Inter-session message]");
        expect(queuedText).toContain("[TASK-COMPLETE] occupancy ready");
        expect(queueMessage).toHaveBeenCalledWith(queuedText, {
          abortSignal: expect.any(AbortSignal),
          toolAuthorityFingerprint: expect.any(String),
          steeringMode: "all",
          debounceMs: 0,
          deliveryTimeoutMs: undefined,
          waitForTranscriptCommit: true,
          onQueueAccepted: expect.any(Function),
          userTurnTranscriptRecorder: expect.any(Object),
        });
      } else if (disposition === "steered") {
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(queueMessage.mock.calls[0]?.[0]).toContain("[TASK-COMPLETE] occupancy ready");
        expect(queueMessage.mock.calls[0]?.[1]?.waitForTranscriptCommit).toBe(true);
        // Guidance joins the receiver's reply owner; it cannot impose a new output policy.
        expect(queueMessage.mock.calls[0]?.[1]).not.toHaveProperty("sourceReplyDeliveryMode");
      } else {
        expect(queueMessage).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { reason: "injection_unavailable" as const, followup: true, mode: undefined },
    { reason: "not_running" as const, followup: true, mode: undefined },
    { reason: "no_active_run" as const, followup: true, mode: undefined },
    { reason: "stale_run" as const, followup: true, mode: undefined },
    { reason: "tool_authority_mismatch" as const, followup: true, mode: undefined },
    { reason: "requester_origin_mismatch" as const, followup: true, mode: undefined },
    { reason: "requester_origin_mismatch" as const, followup: false, mode: "steer" as const },
    { reason: "tool_authority_mismatch" as const, followup: false, mode: "steer" as const },
    { reason: "guarded_injection_unsupported" as const, followup: false, mode: undefined },
    { reason: "runtime_rejected" as const, followup: false, mode: undefined },
    { reason: "injection_unavailable" as const, followup: true, mode: "followup" as const },
    { reason: "injection_unavailable" as const, followup: false, mode: "steer" as const },
  ])(
    "sessions_send handles unaccepted sibling steering: $reason, mode=$mode",
    async ({ reason, followup, mode }) => {
      const key = "agent:main:dashboard:sibling-rejection";
      await seedSession(key, "sibling-rejection-session");
      await activeRun(key, { config: cloneTestConfig(), sessionId: "sibling-rejection-session" });
      const queue = vi
        .spyOn(controllerSteer, "steerSessionControllerOperation")
        .mockResolvedValueOnce({
          status: "rejected",
          reason,
        });
      mockGatewayResponses({
        agent: { runId: "sibling-followup", status: "accepted" },
        "agent.wait": { status: "ok", terminalReply: { disposition: "empty" } },
      });
      try {
        const result = await getSessionTool("sessions_send", {
          agentSessionKey: "agent:main:dashboard:sibling-sender",
        }).execute("unaccepted-sibling", {
          sessionKey: key,
          message: "synthetic update",
          timeoutSeconds: mode === "followup" ? undefined : 0,
          mode,
        });
        expect(result.details).toMatchObject(
          followup
            ? mode === "followup"
              ? { status: "no_reply" }
              : { status: "accepted", targetDisposition: "queued" }
            : { status: "error" },
        );
        const admissions = callGatewayMock.mock.calls.filter(
          ([request]) => request.method === "agent",
        );
        expect(admissions).toHaveLength(followup ? 1 : 0);
        if (followup) {
          expect(admissions[0]?.[0].params).toMatchObject({ sessionKey: key });
        }
        expect(queue).toHaveBeenCalledOnce();
        expect(queue).toHaveBeenCalledWith({
          operation: expect.objectContaining({ sessionId: "sibling-rejection-session" }),
          text: expect.stringContaining("synthetic update"),
          abortOnUnconfirmedTranscript: false,
          options: expect.objectContaining({
            assertCurrent: expect.any(Function),
            waitForTranscriptCommit: true,
          }),
        });
      } finally {
        await settleContinuations();
        queue.mockRestore();
      }
    },
  );
}

type SessionsSendActiveSteeringFixtures = SessionsSendSteeringFixtures & {
  mockAcceptedChildFollowup: () => void;
  runChildFollowup: <T>(run: () => Promise<T>) => Promise<T>;
  createSessionsSendTool: (
    options: Omit<NonNullable<Parameters<typeof createSessionsSendTool>[0]>, "callGateway">,
  ) => AnyAgentTool;
};

export function registerSessionsSendActiveSteeringTests({
  mockAcceptedChildFollowup,
  runChildFollowup,
  getSessionTool: createSessionTool,
  seedSession,
  callGatewayMock,
  mockGatewayResponses,
  settleContinuations,
  cloneTestConfig,
  createSessionsSendTool,
}: SessionsSendActiveSteeringFixtures) {
  const getSessionTool: SessionsSendSteeringFixtures["getSessionTool"] = (name, options) =>
    withTestRequester(createSessionTool(name, options), options.agentSessionKey);

  it.each([
    {
      name: "steers a child after durable admission",
      steered: true,
    },
    {
      name: "starts the same child during compaction",
      rejection: "injection_unavailable" as const,
    },
  ])("sessions_send $name", async (testCase) => {
    const { steered, rejection } = testCase;
    const requesterKey = "agent:main:main";
    const targetKey = "agent:main:subagent:steering-child";
    const sessionId = "own-child-active-session";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: targetKey },
      { sessionId, updatedAt: 1, spawnedBy: requesterKey, spawnDepth: 1 },
    );
    const queueMessage = await activeRun(targetKey, {
      config: cloneTestConfig(),
      sessionId,
      requesterSessionKey: requesterKey,
    });
    const queue = vi.spyOn(controllerSteer, "steerSessionControllerOperation");
    const prepare = vi.spyOn(sessionsSendFollowup, "prepareSessionsSendFollowup");
    try {
      if (rejection) {
        queue.mockResolvedValueOnce({ status: "rejected", reason: rejection });
      }
      mockAcceptedChildFollowup();
      const result = await runChildFollowup(() =>
        getSessionTool("sessions_send", {
          agentSessionKey: requesterKey,
        }).execute("child-send", {
          sessionKey: targetKey,
          message: "deps are ready",
          timeoutSeconds: 0,
        }),
      );
      expect(result.details).toMatchObject({
        status: "accepted",
        sessionKey: targetKey,
        targetDisposition: steered ? "steered" : "queued",
        delivery: { status: steered ? "skipped" : "pending" },
      });
      expect(queue).toHaveBeenCalledOnce();
      expect(queue).toHaveBeenCalledWith({
        operation: expect.objectContaining({ sessionId }),
        text: expect.stringContaining("deps are ready"),
        abortOnUnconfirmedTranscript: false,
        options: {
          assertCurrent: expect.any(Function),
          requesterToolAuthority: expect.objectContaining({
            requesterOrigin: expect.objectContaining({ senderId: "sessions-requester" }),
          }),
          steeringMode: "all",
          debounceMs: 0,
          deliveryTimeoutMs: undefined,
          waitForTranscriptCommit: true,
          onQueueAccepted: expect.any(Function),
          userTurnTranscriptRecorder: expect.any(Object),
        },
      });
      if (steered) {
        expect(queueMessage).toHaveBeenCalledOnce();
      }
      const agentCalls = callGatewayMock.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(agentCalls).toHaveLength(steered ? 0 : 1);
      expect(prepare).toHaveBeenCalledTimes(steered ? 0 : 1);
      if (agentCalls.length) {
        expect(agentCalls[0]?.[0].params).toMatchObject({ sessionKey: targetKey });
        if (rejection) {
          expect(queue.mock.invocationCallOrder[0]).toBeLessThan(
            prepare.mock.invocationCallOrder[0]!,
          );
        }
        expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
          callGatewayMock.mock.invocationCallOrder[
            callGatewayMock.mock.calls.findIndex(([request]) => request.method === "agent")
          ]!,
        );
      }
    } finally {
      await settleContinuations();
      queue.mockRestore();
      prepare.mockRestore();
    }
  });

  it.each([undefined, "steer"] as const)(
    "sessions_send preserves self-send mode=$mode",
    async (mode) => {
      const key = "agent:main:dashboard:self-send";
      await seedSession(key, "self-send-session");
      const queueMessage = await activeRun(key, {
        config: cloneTestConfig(),
        sessionId: "self-send-session",
      });
      mockGatewayResponses({
        agent: { runId: "self-followup", status: "accepted" },
        "agent.wait": { status: "ok", terminalReply: { disposition: "empty" } },
      });
      const tool = withTestRequester(
        createSessionsSendTool({
          agentSessionKey: key,
          requesterOrigin: {
            channel: "telegram",
            accountId: "synthetic-account",
            to: "synthetic-chat",
            threadId: "synthetic-thread",
          },
          config: cloneTestConfig(),
        }),
        key,
      );
      const result = await tool.execute("self-send", {
        sessionKey: key,
        message: "synthetic self followup",
        timeoutSeconds: 0,
        mode,
      });
      expect(result.details).toMatchObject({
        status: "accepted",
        targetDisposition: mode ? "steered" : "queued",
      });
      if (mode) {
        expect(queueMessage).toHaveBeenCalledOnce();
      } else {
        expect(queueMessage).not.toHaveBeenCalled();
      }
      const admissions = callGatewayMock.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(admissions).toHaveLength(mode ? 0 : 1);
      if (!mode) {
        expect(admissions[0]?.[0].params).toMatchObject({
          sessionKey: key,
          channel: "telegram",
          accountId: "synthetic-account",
          to: "synthetic-chat",
          threadId: "synthetic-thread",
        });
      }
      await settleContinuations();
    },
  );

  it.each(
    ([undefined, "followup"] as const).flatMap((mode) =>
      [false, true].flatMap((busy) =>
        [undefined, 0, 1].map((timeoutSeconds) => ({ mode, busy, timeoutSeconds })),
      ),
    ),
  )(
    "sessions_send mailbox mode=$mode busy=$busy timeout=$timeoutSeconds",
    async ({ mode, busy, timeoutSeconds }) => {
      const key = "agent:main:dashboard:mailbox-recipient";
      await seedSession(key, key);
      const queueMessage = busy
        ? await activeRun(key, { config: cloneTestConfig(), sessionId: key })
        : undefined;
      mockGatewayResponses({
        agent: { runId: "synthetic-input-run", status: "accepted" },
        "agent.wait": {
          status: "ok",
          terminalReply: { disposition: "visible", text: "synthetic idle reply" },
        },
      });
      const result = await getSessionTool("sessions_send", {
        agentSessionKey: "agent:main:dashboard:mailbox-sender",
      }).execute("mailbox-input", {
        sessionKey: key,
        message: "synthetic guidance",
        mode,
        timeoutSeconds,
      });
      expect(result.details).toMatchObject(
        busy
          ? { status: "accepted", targetDisposition: "steered", delivery: { status: "skipped" } }
          : timeoutSeconds === 0
            ? { status: "accepted", targetDisposition: "queued" }
            : { status: "ok", reply: "synthetic idle reply" },
      );
      expect(
        callGatewayMock.mock.calls.filter(
          ([request]) => request.method === "agent" && request.params?.sessionKey === key,
        ),
      ).toHaveLength(busy ? 0 : 1);
      if (busy) {
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(
          callGatewayMock.mock.calls.filter(([request]) => request.method === "agent.wait"),
        ).toHaveLength(0);
      }
      await settleContinuations();
      if (busy) {
        expect(
          callGatewayMock.mock.calls.filter(([request]) => request.method === "agent"),
        ).toHaveLength(0);
      }
    },
  );

  it.each([
    { target: "agent:main:main", unconfirmed: false },
    { target: "main", unconfirmed: false },
    { target: "agent:main:main", unconfirmed: true },
  ])(
    "sessions_send steers a busy sibling ($target, unconfirmed=$unconfirmed)",
    async ({ target, unconfirmed }) => {
      const calls: Array<{ method?: string; params?: unknown }> = [];
      const ordinaryActiveKey = "agent:main:main";
      const abort = vi.fn();
      await seedSession("agent:main:dashboard:sibling-sender");
      await seedSession(ordinaryActiveKey, "ordinary-active-session");
      const queueMessage = await activeRun(ordinaryActiveKey, {
        config: cloneTestConfig(),
        sessionId: "ordinary-active-session",
        sourceReplyDeliveryMode: "automatic",
        abort,
      });
      queueMessage.mockImplementationOnce(async (_text, options) => {
        expect(options?.waitForTranscriptCommit).toBe(true);
        if (unconfirmed) {
          options?.onQueueAccepted?.(true);
          throw new Error("synthetic consumption confirmation unavailable after acceptance");
        }
        const recorder = options?.userTurnTranscriptRecorder;
        if (!recorder || !(await recorder.persistApproved())) {
          throw new Error("Steering fixture did not commit the admitted guidance");
        }
      });
      callGatewayMock.mockImplementation(async (request) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "ordinary-agent-run", status: "accepted", acceptedAt: 2000 };
        }
        return {};
      });

      const tool = getSessionTool("sessions_send", {
        agentSessionKey: "agent:main:dashboard:sibling-sender",
        agentChannel: "telegram",
        config: cloneTestConfig(),
      });

      const result = await tool.execute("call-ordinary-active", {
        sessionKey: target,
        message: "synthetic sibling update",
        timeoutSeconds: 0,
      });

      if (unconfirmed) {
        // Uncertain commitment stays with the receiver and cannot be replayed.
        expect(result.details).toMatchObject({
          status: "error",
          sessionKey: target,
          error: "synthetic consumption confirmation unavailable after acceptance",
        });
      } else {
        expect(result.details).toMatchObject({
          status: "accepted",
          sessionKey: target,
          targetDisposition: "steered",
          delivery: { status: "skipped" },
        });
      }
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(queueMessage).toHaveBeenCalledWith(
        expect.stringContaining("synthetic sibling update"),
        expect.objectContaining({ waitForTranscriptCommit: true }),
      );
      expect(calls.filter((call) => call.method === "agent")).toHaveLength(0);
      expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(0);
      expect(abort).not.toHaveBeenCalled();
    },
  );
}
