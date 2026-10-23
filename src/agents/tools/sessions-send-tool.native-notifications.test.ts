import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { loadCodexNativeWebSearchTestFixture } from "../../../extensions/codex/test-api.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { CodexAttemptRuntime } from "../../../test/types/vitest-codex-attempt-runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../gateway/device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { getTrackedWorkerPoolSnapshot } from "../../infra/worker-cpu.js";
import * as harnessRuntime from "../../plugin-sdk/agent-harness-runtime.js";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "../../plugin-sdk/plugin-test-runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "../agent-bundle-mcp-manager-api.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

const fixture = await loadCodexNativeWebSearchTestFixture();
beforeEach((context) => {
  let scheduler: ReturnType<typeof createTestGatewayScheduler> | undefined;
  const runtime: CodexAttemptRuntime = {
    readWorkerPools: getTrackedWorkerPoolSnapshot,
    async start() {
      scheduler = createTestGatewayScheduler();
      await setSessionMcpRuntimeScheduler(scheduler);
    },
    async stop() {
      scheduler?.beginClose();
      try {
        await disposeAllSessionMcpRuntimes();
      } finally {
        await scheduler?.stop();
      }
    },
  };
  context.codexAttemptRuntime = runtime;
});
fixture.setupRunAttemptTestHooks();

it.each([
  "allowed",
  "runtime-before-dispatch",
  "revoked-before-dispatch",
  "replaced-before-dispatch",
] as const)("keeps native sessions_send admission current: %s", async (scenario) => {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  const key = "agent:main:dashboard:native-sharing";
  const id = "native-sharing-session";
  const requesterKey = "agent:main:main";
  const cfg = {
    agents: { ownership: "explicit" as const, entries: { main: {} } },
    tools: {
      sessions: { visibility: "all" as const },
      agentToAgent: { enabled: true },
      web: { search: { enabled: false } },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  for (const [sessionKey, sessionId] of [
    [key, id],
    [requesterKey, "requester-session"],
  ] as const) {
    await replaceSessionEntry({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
  }
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  const context = createContext([], () => cfg);
  const owner = createOperatorClient({ profileName: "native-sharing", scopes: ["operator.write"] });
  const source = captureGatewayDeviceRevocation(
    context,
    { deviceId: "sender-device", role: "operator" },
    () => true,
  );
  const receiverSource = captureGatewayDeviceRevocation(
    context,
    { deviceId: "receiver-device", role: "operator" },
    () => true,
  );
  const receiverAuthority = await captureGatewayOperatorRunAuthority({
    client: owner,
    context,
    hasCurrentClientAuthority: receiverSource.isCurrent,
  });
  if (!receiverAuthority) {
    throw new Error("Receiver authority missing");
  }
  const requesterOrigin = {
    sessionKey: requesterKey,
    operatorProfileId: owner.authenticatedUserProfile!.profileId,
  };
  const params = fixture.createParams(
    path.join(fixture.tempDir, "native-sharing.jsonl"),
    fixture.tempDir,
    { sessionKey: key, sessionId: id, runId: "receiver-run", provider: "openai" },
  );
  params.config = cfg;
  params.sessionTarget = { agentId: "main", storePath };
  params.timeoutMs = 60_000;
  params.requesterOrigin = requesterOrigin;
  const abort = new AbortController();
  params.abortSignal = abort.signal;
  fixture.setCodexTestToolFactory(params, () => []);
  const closeHost = await fixture.bindProductionHarnessHostCapabilitiesForTest(
    params,
    receiverAuthority.authority,
  );
  const registry = createPluginRegistry({
    runtime: createPluginRuntimeMock({ config: { current: () => cfg } }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "codex", origin: "bundled" });
  registry.registry.plugins.push(record);
  registry.createApi(record, { config: cfg }).registerAgentHarness(
    fixture.createCodexAppServerAgentHarness({
      bindingStore: fixture.testCodexAppServerBindingStore,
    }),
  );
  setActivePluginRegistry(registry.registry);
  const wire = await fixture.createLeasedCodexLifecycleHarness({
    agentDir: path.join(fixture.tempDir, "wire-agent"),
    persistedThreads: [],
    respond(method) {
      if (method === "thread/start") {
        return fixture.threadStartResult();
      }
      if (method === "turn/start") {
        return fixture.turnStartResult();
      }
      if (method === "turn/steer") {
        return { turnId: "turn-1" };
      }
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "skills/list" || method === "thread/backgroundTerminals/list") {
        return { data: [], nextCursor: null };
      }
      return {};
    },
  });
  vi.spyOn(fixture.CodexAppServerClient, "start").mockResolvedValue(wire.client);
  fixture.setCodexAppServerClientFactoryForTest(async (_s, _a, _d, _c, options) =>
    fixture.getLeasedSharedCodexAppServerClient({
      ...options,
      ...wire.acquireOptions,
      preparedAuth: undefined,
      authRequirement: undefined,
    }),
  );
  const registered = vi.spyOn(harnessRuntime, "setActiveEmbeddedRun");
  const run = fixture.runCodexAppServerAttempt(params, {
    registeredHarness: registry.registry.agentHarnesses[0]!.harness,
  });
  let delivery: Promise<unknown> | undefined;
  try {
    await run.waitForTurnAccepted();
    const backend = registered.mock.calls.findLast((call) => call[0] === id)?.[1]
      ?.messageInjectionV2;
    if (!backend?.queueMessageAsync) {
      throw new Error("Registered native queue missing");
    }
    const nativeQueue = backend.queueMessageAsync.bind(backend);
    const queueSpy = vi.spyOn(backend, "queueMessageAsync").mockImplementation(async (...args) => {
      // Exercise a live publication after tool authorization, before native effects.
      if (scenario === "runtime-before-dispatch") {
        sessionChanges.emit({ sessionKey: key, agentId: "main", storePath, scope: "runtime" });
      } else if (scenario === "revoked-before-dispatch") {
        invalidateGatewayDeviceRevocation(context, "sender-device", "operator");
      } else if (scenario === "replaced-before-dispatch") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key },
          { sessionId: "replacement-session", updatedAt: 2 },
        );
      }
      return await nativeQueue(...args);
    });
    // Only target discovery is fixed I/O; authorization, controller, native queue,
    // and its original sessions_send recorder remain the production composition.
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ) => {
      if (request.method === "sessions.resolve") {
        return { key, agentId: "main" } as T;
      }
      if (request.method === "sessions.list") {
        return { sessions: [{ key, agentId: "main", kind: "direct" }] } as T;
      }
      throw new Error(`Unexpected Gateway method: ${request.method}`);
    };
    const result = withPluginRuntimeGatewayRequestScope(
      {
        client: owner,
        context,
        isWebchatConnect: () => false,
        hasCurrentClientAuthority: source.isCurrent,
      },
      () =>
        withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: owner.authenticatedUserProfile,
            scopes: owner.connect.scopes ?? [],
          },
          () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: requesterKey,
                requesterOrigin,
                operatorAuthority:
                  getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
                gatewayContextResolver: () => context,
                receiptAuthority: () => true,
              },
              () =>
                createSessionsSendTool({
                  agentSessionKey: requesterKey,
                  config: cfg,
                  idempotencyKey: "native-guidance",
                  callGateway,
                }).execute("native-send", {
                  sessionKey: key,
                  mode: "steer",
                  timeoutSeconds: 0,
                  message: "Synthetic peer guidance",
                }),
            ),
        ),
    );
    delivery = result;
    const denied =
      scenario === "revoked-before-dispatch" || scenario === "replaced-before-dispatch";
    if (denied) {
      expect((await result).details).toMatchObject({ status: "error" });
    } else {
      await awaitGateBeforeSettlement(
        wire.waitForMethod("turn/steer").then(() => {}),
        result.then((value) => {
          throw new Error(`Tool returned before native dispatch: ${JSON.stringify(value.details)}`);
        }),
        "Native dispatch",
      );
      const steer = wire.request.mock.calls.find(([method]) => method === "turn/steer")?.[1] as {
        clientUserMessageId: string;
      };
      wire.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "native-guidance", type: "userMessage", clientId: steer.clientUserMessageId },
        },
      });
      expect((await result).details).toMatchObject({
        status: "accepted",
        targetDisposition: "steered",
      });
    }
    expect(queueSpy).toHaveBeenCalledOnce();
    expect(wire.request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
      denied ? 0 : 1,
    );
    for (const sessionId of [
      id,
      ...(scenario === "replaced-before-dispatch" ? ["replacement-session"] : []),
    ]) {
      const messages = (await loadTranscriptEvents({ agentId: "main", storePath, sessionId }))
        .map(readTranscriptEventMessage)
        .filter((message) => message?.idempotencyKey === "native-guidance:user");
      expect(messages).toHaveLength(denied ? 0 : 1);
    }
  } finally {
    abort.abort("native-proof-cleanup");
    await Promise.allSettled([run, ...(delivery ? [delivery] : [])]);
    closeHost();
    receiverAuthority.release();
    receiverSource.release();
    source.release();
    registered.mockRestore();
    await disposePluginRegistryInstances(registry.registry);
    await state.cleanup();
  }
});
