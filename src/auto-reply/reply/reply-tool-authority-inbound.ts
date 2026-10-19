import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import {
  captureRequesterOrigin,
  resolveRequesterPrincipalKey,
} from "../../agents/requester-origin.js";
import { resolveRequesterConversationToolPolicy } from "../../agents/requester-tool-policy.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import type {
  ReplyToolAuthorityClientDiscovery,
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRequester,
} from "../../sessions/session-controller.contracts.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import { internalSessionConversationId } from "../../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../../utils/message-channel-core.js";
import { getRequesterProfile } from "../requester-profile.js";
import { shouldUseFromAsSenderFallback } from "../sender-identity.js";
import type { RuntimeMsgContext } from "../templating.js";
import { MessageInjectionRequesterMismatchError } from "./message-injection-authority.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { ReplyToolAuthorityInput } from "./reply-tool-authority.types.js";

export function normalizeIncomingClientDiscovery<T extends ReplyToolAuthorityClientDiscovery>(
  snapshot: ReplyToolAuthorityClientDiscovery,
  input: T,
): T {
  const incoming = { ...input, run: { ...input.run } };
  if (
    incoming.operatorAuthority &&
    snapshot.operatorAuthority?.profileId === incoming.operatorAuthority.profileId
  ) {
    // Steering can add client features without expanding this turn's frozen tools.
    if ((snapshot.run.clientCaps ?? []).every((cap) => incoming.run.clientCaps?.includes(cap))) {
      incoming.run.clientCaps = snapshot.run.clientCaps ? [...snapshot.run.clientCaps] : undefined;
    }
    // A newly connected UI cannot add a personal target to a headless turn.
    if (!snapshot.run.gatewayUiCommandTarget) {
      incoming.run.gatewayUiCommandTarget = undefined;
    }
  }
  return incoming;
}

export function applyReplyToolAuthorityRequester(
  snapshot: ReplyToolAuthorityInput,
  requester: ReplyToolAuthorityRequester,
): ReplyToolAuthorityInput {
  return {
    ...snapshot,
    run: {
      ...snapshot.run,
      config: captureRuntimeConfig(requester.config),
      requesterOrigin: captureRequesterOrigin(requester),
      // This is a fresh request, not the incumbent's external snapshot or completion.
      conversationToolPolicy: undefined,
      trustedInternalHandoff: undefined,
      inputProvenance: undefined,
      scheduledToolPolicy: undefined,
    },
  };
}

export function applyReplyToolAuthorityOverlay(
  snapshot: ReplyToolAuthorityInput,
  overlay: ReplyToolAuthorityOverlay,
): ReplyToolAuthorityInput {
  // Human input keeps the completion's verified execution scope, never replacing its policy.
  const retainCompletion =
    overlay.operatorAuthority &&
    snapshot.operatorAuthority?.profileId === overlay.operatorAuthority.profileId &&
    snapshot.run.trustedInternalHandoff &&
    overlay.senderIsOwner &&
    (!overlay.inputProvenance || overlay.inputProvenance.kind === "external_user");
  return {
    ...snapshot,
    originatingChannel: overlay.originatingChannel,
    operatorAuthority: overlay.operatorAuthority,
    toolsAllow: overlay.toolsAllow,
    disableTools: overlay.disableTools,
    forceRestartSafeTools: overlay.forceRestartSafeTools,
    forceCodeModeTools: overlay.forceCodeModeTools,
    run: {
      ...snapshot.run,
      requesterOrigin: undefined,
      permissionMode: overlay.permissionMode,
      toolOverrides: overlay.toolOverrides,
      messageProvider: overlay.messageProvider,
      chatType: overlay.chatType,
      agentAccountId: overlay.agentAccountId,
      conversationToolPolicy: overlay.conversationToolPolicy,
      conversationId: overlay.conversationId,
      messageThreadId: overlay.messageThreadId,
      groupId: overlay.groupId,
      groupChannel: overlay.groupChannel,
      groupSpace: overlay.groupSpace,
      memberRoleIds: overlay.memberRoleIds,
      spawnedBy: overlay.spawnedBy,
      senderId: overlay.senderId,
      senderName: overlay.senderName,
      senderUsername: overlay.senderUsername,
      senderE164: overlay.senderE164,
      senderIsOwner: overlay.senderIsOwner,
      gitContributorProfileId: overlay.gitContributorProfileId,
      inputProvenance: retainCompletion ? snapshot.run.inputProvenance : overlay.inputProvenance,
      trustedInternalHandoff: retainCompletion
        ? snapshot.run.trustedInternalHandoff
        : overlay.trustedInternalHandoff,
      scheduledToolPolicy: overlay.scheduledToolPolicy,
      runtimePluginToolGrant: overlay.runtimePluginToolGrant,
      traceAuthorized: overlay.traceAuthorized,
      approvalReviewerDeviceId: overlay.approvalReviewerDeviceId,
      clientCaps: overlay.clientCaps,
      gatewayUiCommandTarget: overlay.gatewayUiCommandTarget,
      toolBindings: overlay.toolBindings,
    },
  };
}

/** Projects current inbound facts against the active run's frozen authority snapshot. */
export function resolveInboundReplyToolAuthorityOverlay(params: {
  ctx: RuntimeMsgContext;
  sessionEntry?: Pick<SessionEntry, "permissionMode" | "spawnedBy" | "toolOverrides">;
  senderIsOwner: boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  toolsAllow?: string[];
  disableTools: boolean;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
}): ReplyToolAuthorityOverlay {
  const { ctx } = params;
  const senderId = normalizeOptionalString(ctx.SenderId);
  const senderE164 = normalizeOptionalString(ctx.SenderE164);
  return {
    sessionKey: normalizeOptionalString(ctx.SessionKey),
    operatorAuthority: params.operatorAuthority,
    permissionMode: params.sessionEntry?.permissionMode,
    toolOverrides: params.sessionEntry?.toolOverrides,
    originatingChannel: ctx.OriginatingChannel,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: ctx.OriginatingChannel,
      provider: ctx.Provider ?? ctx.Surface,
    }),
    chatType: normalizeChatType(ctx.ChatType),
    agentAccountId: ctx.AccountId,
    conversationToolPolicy: ctx.ConversationToolPolicy,
    conversationId: normalizeOptionalString(ctx.ChatId),
    messageThreadId: ctx.MessageThreadId,
    groupId: resolveGroupSessionKey(ctx)?.id,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    memberRoleIds: normalizeArrayBackedTrimmedStringList(ctx.MemberRoleIds),
    spawnedBy: normalizeOptionalString(params.sessionEntry?.spawnedBy),
    senderId:
      senderId ??
      (!senderE164 && shouldUseFromAsSenderFallback({ from: ctx.From, chatType: ctx.ChatType })
        ? normalizeOptionalString(ctx.From)
        : undefined),
    senderName: normalizeOptionalString(ctx.SenderName),
    senderUsername: normalizeOptionalString(ctx.SenderUsername),
    senderE164,
    senderIsOwner: params.senderIsOwner,
    gitContributorProfileId: getRequesterProfile(ctx)?.id ?? readSessionInputProfileId(ctx),
    inputProvenance: ctx.InputProvenance,
    trustedInternalHandoff: undefined,
    scheduledToolPolicy: undefined,
    runtimePluginToolGrant: undefined,
    toolsAllow: params.toolsAllow,
    disableTools: params.disableTools,
    forceRestartSafeTools: params.forceRestartSafeTools,
    forceCodeModeTools: params.forceCodeModeTools,
    traceAuthorized:
      params.senderIsOwner || (ctx.GatewayClientScopes ?? []).includes("operator.admin"),
    approvalReviewerDeviceId: normalizeOptionalString(ctx.ApprovalReviewerDeviceId),
    clientCaps: ctx.GatewayClientCaps,
    gatewayUiCommandTarget: ctx.GatewayUiCommandTarget,
    toolBindings: ctx.GatewayRunToolBindings,
  };
}

/** Resolve configured conversation policy from the same trusted ingress facts as steering. */
export function resolveInboundConversationToolPolicy(params: {
  ctx: RuntimeMsgContext;
  config: OpenClawConfig;
  sessionKey?: string;
}) {
  const facts = resolveInboundReplyToolAuthorityOverlay({
    ctx: params.ctx,
    senderIsOwner: false,
    disableTools: false,
  });
  return resolveRequesterConversationToolPolicy({
    ...facts,
    config: params.config,
    sessionKey: params.sessionKey ?? params.ctx.SessionKey,
    accountId: facts.agentAccountId,
    conversationPolicy: facts.conversationToolPolicy,
  });
}

/** Session sharing alone does not establish that two inputs belong to the same conversation. */
export function isSameReplyToolAuthorityConversation(
  snapshot: ReplyToolAuthorityInput,
  caller: ReplyToolAuthorityOverlay,
): boolean {
  const execution = snapshot.run;
  const channel = normalizeMessageChannel(execution.messageProvider ?? snapshot.originatingChannel);
  const incomingChannel = normalizeMessageChannel(
    caller.messageProvider ?? caller.originatingChannel,
  );
  const conversationId =
    normalizeOptionalString(execution.conversationId) ??
    (channel && internalSessionConversationId(channel, execution.sessionKey));
  const incomingConversationId =
    normalizeOptionalString(caller.conversationId) ??
    (incomingChannel && internalSessionConversationId(incomingChannel, caller.sessionKey));
  return Boolean(
    channel &&
    channel === incomingChannel &&
    conversationId &&
    conversationId === incomingConversationId &&
    normalizeAccountId(execution.agentAccountId) === normalizeAccountId(caller.agentAccountId) &&
    stringifyRouteThreadId(execution.messageThreadId) ===
      stringifyRouteThreadId(caller.messageThreadId),
  );
}

export function assertCurrentOperatorAuthority(
  authority: AdmittedRunOperatorAuthority | undefined,
): void {
  if (authority) {
    assertAdmittedRunOperatorAuthority(authority);
    authority.assertCurrent();
  }
}

export function projectReplyToolAuthorityInput(
  snapshot: ReplyToolAuthorityInput,
  caller: ReplyToolAuthorityOverlay | ReplyToolAuthorityRequester | undefined,
  requesterPrincipalKey: string | undefined,
): ReplyToolAuthorityInput {
  const incomingRequester =
    caller && !("requesterOrigin" in caller) && caller.allowCollaborativeSteering
      ? resolveRequesterPrincipalKey({ ...caller, messageChannel: caller.originatingChannel })
      : undefined;
  if (
    caller &&
    !("requesterOrigin" in caller) &&
    caller.allowCollaborativeSteering &&
    requesterPrincipalKey &&
    incomingRequester &&
    incomingRequester !== requesterPrincipalKey &&
    (!caller.inputProvenance || caller.inputProvenance.kind === "external_user") &&
    isSameReplyToolAuthorityConversation(snapshot, caller)
  ) {
    assertCurrentOperatorAuthority(caller.operatorAuthority);
    // Only the policy projection uses the incumbent. The input and its author
    // remain unchanged, including if injection later falls back to a new turn.
    return snapshot;
  }
  const incoming = !caller
    ? snapshot
    : normalizeIncomingClientDiscovery(
        snapshot,
        "requesterOrigin" in caller
          ? applyReplyToolAuthorityRequester(snapshot, caller)
          : applyReplyToolAuthorityOverlay(snapshot, caller),
      );
  // Unidentified executions may run, but cannot lend their identity to new human input.
  if (
    caller &&
    (!requesterPrincipalKey ||
      requesterPrincipalKey !==
        resolveRequesterPrincipalKey({
          ...incoming.run,
          messageChannel: incoming.originatingChannel,
          operatorAuthority: incoming.operatorAuthority,
        }))
  ) {
    throw new MessageInjectionRequesterMismatchError();
  }
  return incoming;
}
