import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { resolveInboundReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-tool-authority-inbound.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  registerSubagentCompletionToolHandoff,
  consumeSubagentCompletionToolHandoff,
} from "../../gateway/subagent-completion-tool-handoff.js";
import { beginReplyMessageInjectionTarget } from "../../sessions/session-controller.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { projectConversationToolNames } from "../conversation-tool-policy-pipeline.js";
import { testing } from "../embedded-agent-runner/runs.test-support.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { withPreparedSessionCapabilityRead } from "../subagents/spawn/subagent-session-store.js";
import {
  attempt,
  published,
  sessionId,
  sessionKey,
} from "./tool-authority.runtime.test-support.js";

const dirs = useSessionStoreTempDirs(afterAll, "openclaw-direct-handoff-");
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
});
it.each([
  "plain-owner",
  "trusted-completion",
  "lower-scopes",
  "revoked-source",
  "revoked-cohort",
  "other-profile",
  "peer-owner",
  "late-cohort-revocation",
  "optional-completion",
] as const)(
  "qualifies canonical direct completion scope against owner input: %s",
  async (scenario) => {
    const storePath = path.join(dirs.make(), "sessions.json");
    const config = { session: { store: storePath }, tools: { allow: ["read", "exec"] } };
    const sourceSessionKeys = [
      "agent:main:subagent:synthetic-first",
      "agent:main:subagent:synthetic-second",
    ] as const;
    await replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: 1 });
    for (const key of sourceSessionKeys) {
      await replaceSessionEntry(
        { storePath, sessionKey: key },
        {
          sessionId: key + "-session",
          updatedAt: 1,
          spawnedBy: sessionKey,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read", "exec"],
          inheritedToolDeny: [],
        },
      );
    }
    let current = true;
    const registration = {
      sourceSessionKey: sourceSessionKeys[0],
      targetSessionKey: sessionKey,
      targetSessionId: sessionId,
      idempotencyKey: "synthetic-settle-batch",
      settleBatch: { sourceSessionKeys, isCurrent: () => current },
    };
    const trustedInternalHandoff = consumeSubagentCompletionToolHandoff({
      ...registration,
      handoffId: registerSubagentCompletionToolHandoff(registration),
      sourceTool: "subagent_settle",
      provider: attempt.provider,
      model: attempt.modelId,
    });
    expect(trustedInternalHandoff).toBeDefined();
    const inputProvenance = {
      kind: "inter_session" as const,
      sourceTool: "subagent_settle",
      sourceSessionKey: sourceSessionKeys[0],
    };
    const isCompletion = scenario !== "plain-owner";
    const policyParams = {
      config,
      sessionKey,
      sessionId,
      agentId: "main",
      senderIsOwner: true,
      modelProvider: attempt.provider,
      modelId: attempt.modelId,
      messageProvider: "webchat",
      messageChannel: "webchat",
    };
    const profiles = await withPreparedSessionCapabilityRead(
      () =>
        [
          resolveConversationCapabilityProfile({
            ...policyParams,
            ...(isCompletion ? { inputProvenance, trustedInternalHandoff } : {}),
          }),
          resolveConversationCapabilityProfile(policyParams),
        ] as const,
    );
    for (const profile of profiles) {
      expect(
        projectConversationToolNames({
          capabilityProfile: profile,
          toolNames: ["read", "exec", "write", "sessions_send", "plugins"],
          warn: () => {},
        }),
      ).toEqual(["read", "exec"]);
    }
    if (isCompletion) {
      expect(profiles[0].policy.requesterPolicySource).toBe("completion-handoff");
      expect(profiles[1].policy.requesterPolicySource).not.toBe("completion-handoff");
    }
    const scopes = [
      "operator.admin",
      "operator.approvals",
      "operator.pairing",
      "operator.questions",
      "operator.read",
      "operator.write",
    ];
    const modelPolicy = prepareOperatorModelPolicy({ cfg: config, policy: {} });
    const authority = (incoming = false) =>
      createAdmittedRunOperatorAuthority({
        profileId: incoming && scenario === "other-profile" ? "synthetic-other" : "synthetic-owner",
        scopes: incoming && scenario === "lower-scopes" ? ["operator.read"] : scopes,
        gatewayAccessGrant: null,
        modelPolicy,
        assertCurrent() {
          if (incoming && scenario === "revoked-source") {
            throw new Error("Synthetic incoming authority revoked");
          }
        },
      });
    await published(
      async ({ handle, queue }) => {
        handle.supportsTranscriptCommitWait = true;
        handle.terminalReplyExpectation =
          scenario === "optional-completion" ? "optional" : "required";
        let observedLateRevocation = false;
        handle.messageInjectionV2 = {
          version: 2,
          isAvailable: () => true,
          queueMessage: async (text, options, assertCurrent) => {
            if (scenario === "late-cohort-revocation") {
              current = false;
              observedLateRevocation = true;
            }
            assertCurrent();
            return queue(text, options);
          },
        };
        if (scenario === "revoked-cohort") {
          current = false;
        }
        const overlay = resolveInboundReplyToolAuthorityOverlay({
          ctx: finalizeInboundContext({
            Provider: "webchat",
            Surface: "webchat",
            OriginatingChannel: "webchat",
            ChatType: "direct",
            GatewayClientScopes: scopes,
            GatewayClientCaps: [],
            ...(scenario === "peer-owner"
              ? {
                  InputProvenance: {
                    kind: "inter_session" as const,
                    sourceTool: "sessions_send",
                    sourceSessionKey: "agent:main:subagent:synthetic-peer",
                  },
                }
              : {}),
          }),
          senderIsOwner: true,
          operatorAuthority: authority(true),
          disableTools: false,
        });
        const target = captureCurrentReplyMessageInjectionTarget(sessionKey);
        expect(target).toBeDefined();
        const injection = await beginReplyMessageInjectionTarget(
          target!,
          "Synthetic owner correction",
          { isInboundUserMessage: true, toolAuthorityOverlay: overlay },
        );
        const accepts = scenario === "plain-owner" || scenario === "trusted-completion";
        if (scenario === "late-cohort-revocation") {
          await expect(injection.outcome).resolves.not.toMatchObject({ status: "accepted" });
        } else {
          await expect(injection.outcome).resolves.toMatchObject(
            accepts
              ? { status: "accepted" }
              : {
                  status: "rejected",
                  reason:
                    scenario === "optional-completion"
                      ? "reply_expectation_mismatch"
                      : "tool_authority_mismatch",
                },
          );
        }
        expect(observedLateRevocation).toBe(scenario === "late-cohort-revocation");
        expect(queue).toHaveBeenCalledTimes(accepts ? 1 : 0);
      },
      {
        config,
        messageChannel: "webchat",
        messageProvider: "webchat",
        chatType: "direct",
        clientCaps: [],
        ...(isCompletion ? { inputProvenance, trustedInternalHandoff } : {}),
      },
      authority(),
    );
  },
);
