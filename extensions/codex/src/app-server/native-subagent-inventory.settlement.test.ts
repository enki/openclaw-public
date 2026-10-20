import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { fixture } from "./native-subagent-inventory.test-support.js";
import {
  childTurnCompletedNotification,
  closeAgentNotification,
  createClient,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import { setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());
setupRunAttemptTestHooks();

it("settles delayed close writes without consuming a replacement monitor's resumed assignment", async () => {
  const f = await fixture();
  const firstClient = createClient();
  const first = await f.register(firstClient);
  await first.ready;
  first.bindTurn("parent-turn");

  const initialRecorded = createDeferred<void>();
  const consumeEntered = createDeferred<void>();
  const mutate = f.store.mutate.bind(f.store);
  vi.spyOn(f.store, "mutate").mockImplementation(async (identity, mutation, assertCurrent) => {
    const result = mutate(identity, mutation, assertCurrent);
    if (mutation.kind === "consume-native-subagent-assignment") {
      consumeEntered.resolve();
    }
    const applied = await result;
    if (
      applied &&
      mutation.kind === "record-native-subagent-assignment" &&
      mutation.assignment.nativeTurnId === "child-turn"
    ) {
      initialRecorded.resolve();
    }
    return applied;
  });
  await f.spawn(firstClient);
  await initialRecorded.promise;
  await firstClient.notify(childTurnCompletedNotification({ status: "interrupted" }));

  const closeEntered = createDeferred<void>();
  const closeResponse = createDeferred<{ data: string[]; nextCursor: null }>();
  const request = firstClient.request.getMockImplementation();
  assert(request);
  firstClient.request.mockImplementation(async (method, ...args) => {
    if (method === "thread/loaded/list") {
      closeEntered.resolve();
      return await closeResponse.promise;
    }
    return await request(method, ...args);
  });
  await firstClient.notify(closeAgentNotification({ method: "item/started" }));
  const closing = firstClient.notify(closeAgentNotification({ method: "item/completed" }));
  await closeEntered.promise;

  const peer = f.newBindingStore();
  const leaseEntered = createDeferred<void>();
  const recover = createDeferred<void>();
  const releaseLease = createDeferred<void>();
  const successorRecorded = createDeferred<void>();
  const peerMutate = peer.mutate.bind(peer);
  vi.spyOn(peer, "mutate").mockImplementation(async (identity, mutation, assertCurrent) => {
    const applied = await peerMutate(identity, mutation, assertCurrent);
    if (
      applied &&
      mutation.kind === "record-native-subagent-assignment" &&
      mutation.assignment.nativeTurnId === "resumed-turn"
    ) {
      successorRecorded.resolve();
    }
    return applied;
  });
  const nextClient = createClient();
  const history = threadRead({ turnId: "child-turn", status: "interrupted" });
  const continuation = threadRead({
    turnId: "resumed-turn",
    status: "inProgress",
    threadStatus: "active",
  });
  assert(history.thread.turns && continuation.thread.turns);
  history.thread.turns.push(...continuation.thread.turns);
  history.thread.status = { type: "active" };
  nextClient.setThreadRead("child-thread", history);
  const replacement = createDeferred<Awaited<ReturnType<typeof f.register>>>();
  let cleaningUp = false;
  const lease = peer.withLease(f.identity, async () => {
    leaseEntered.resolve();
    await recover.promise;
    if (cleaningUp) {
      return;
    }
    const next = await f.register(nextClient, f.historyOwner(), undefined, undefined, {
      bindingStore: peer,
    });
    await next.ready;
    replacement.resolve(next);
    await releaseLease.promise;
  });
  void lease.catch((error: unknown) => replacement.reject(error));
  onTestFinished(async () => {
    cleaningUp = true;
    closeResponse.resolve({ data: [], nextCursor: null });
    recover.resolve();
    releaseLease.resolve();
    await lease;
  });
  await leaseEntered.promise;

  let unregistered = false;
  const unregister = first.unregister().then(() => {
    unregistered = true;
  });
  // The initial drain finishes while native close confirmation is still pending.
  await vi.advanceTimersByTimeAsync(0);
  closeResponse.resolve({ data: [], nextCursor: null });
  await closing;
  await consumeEntered.promise;
  firstClient.close();
  recover.resolve();
  const next = await replacement.promise;
  await successorRecorded.promise;
  const earlyUnregister = unregistered;
  releaseLease.resolve();
  await lease;
  await vi.advanceTimersByTimeAsync(1_000);
  await unregister;
  first.closeCaller();

  expect
    .soft(earlyUnregister, "Unregister must join writes accepted by close settlement")
    .toBe(false);
  expect
    .soft(
      await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner()),
      "The previous monitor must not consume the resumed assignment",
    )
    .toEqual([
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        nativeTurnId: "resumed-turn",
      }),
    ]);
  await nextClient.notify(
    childTurnCompletedNotification({
      turnId: "resumed-turn",
      status: "completed",
      items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Resumed result" }],
    }),
  );
  await next.unregister();
  next.closeCaller();
  expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      childSessionKey: "codex-thread:child-thread",
      result: "Resumed result",
    }),
  );
  expect(await f.store.readNativeSubagentAssignments?.(f.identity, f.historyOwner())).toEqual([]);
  nextClient.close();
  const duplicate = await f.register(createClient());
  await duplicate.ready;
  await duplicate.unregister();
  expect(f.deliver).toHaveBeenCalledOnce();
});

it.each(["current", "gateway-revoked"] as const)(
  "joins the owned assignment acknowledgement before detached completion (%s)",
  async (authority) => {
    const f = await fixture();
    const client = createClient();
    const parent = await f.register(client);
    const recordEntered = createDeferred<void>();
    const acknowledgeRecord = createDeferred<void>();
    const pending: { completion?: Promise<void> } = {};
    onTestFinished(async () => {
      acknowledgeRecord.resolve();
      await pending.completion;
      await parent.unregister();
      client.close();
      parent.closeCaller();
    });
    await parent.ready;
    parent.bindTurn("parent-turn");
    // Leave the first observed native turn for the completion notification path
    // to persist. The foreground owner has already left when the child ends.
    await f.spawn(client, false);
    await parent.unregister();

    const mutate = f.store.mutate.bind(f.store);
    vi.spyOn(f.store, "mutate").mockImplementation(async (...args) => {
      const applied = await mutate(...args);
      const mutation = args[1];
      if (
        applied &&
        mutation.kind === "record-native-subagent-assignment" &&
        mutation.assignment.nativeTurnId === "child-turn"
      ) {
        // Use the actual mutation and its authority; hold only its successful
        // acknowledgement. The monitor must join its owned producer even when
        // this test store already exposes the committed row synchronously.
        recordEntered.resolve();
        await acknowledgeRecord.promise;
      }
      return applied;
    });
    await client.notify(turnStartedNotification("child-turn"));
    const finished = () =>
      childTurnCompletedNotification({
        status: "completed",
        items: [
          {
            id: "held-record-final",
            type: "agentMessage",
            phase: "final_answer",
            text: "Result after the assignment acknowledgement.",
          },
        ],
      });
    const completion = client.notify(finished());
    pending.completion = completion;
    await recordEntered.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect
      .soft(f.deliver, "Completion cannot escape its owned assignment write")
      .not.toHaveBeenCalled();
    if (authority === "gateway-revoked") {
      // Revoke actual host-issued custody while the owner awaits its write.
      parent.closeGateway();
    }
    acknowledgeRecord.resolve();
    await completion;
    if (authority === "gateway-revoked") {
      expect(f.deliver).not.toHaveBeenCalled();
    } else {
      expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          childSessionKey: "codex-thread:child-thread",
          expectedRequester: {
            sessionId: f.identity.sessionId,
            lifecycleRevision: f.historyOwner().lifecycleRevision,
          },
          result: "Result after the assignment acknowledgement.",
        }),
      );
      await client.notify(finished());
      expect(f.deliver).toHaveBeenCalledOnce();
    }
  },
);
