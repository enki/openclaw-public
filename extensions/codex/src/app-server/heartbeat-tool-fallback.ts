import {
  applyEmbeddedAttemptToolsAllow,
  HEARTBEAT_RESPONSE_TOOL_NAME,
  normalizeHeartbeatToolResponse,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexPluginConfig } from "./config.js";
import type { CodexToolDescriptor } from "./dynamic-tool-catalog.js";
import { filterCodexDynamicTools } from "./dynamic-tool-profile.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

type InactiveCodexHeartbeatResponseDescriptor = Pick<
  CodexToolDescriptor,
  "name" | "description" | "parameters"
>;

export function resolveInactiveCodexHeartbeatResponseDescriptor(params: {
  registeredTools: readonly CodexToolDescriptor[];
  registeredSpecs?: readonly CodexDynamicToolSpec[];
}): InactiveCodexHeartbeatResponseDescriptor | undefined {
  if (params.registeredSpecs) {
    const descriptor = flattenCodexDynamicToolFunctions(params.registeredSpecs).find(
      (tool) => tool.name === HEARTBEAT_RESPONSE_TOOL_NAME,
    );
    return descriptor
      ? {
          name: descriptor.name,
          description: descriptor.description,
          parameters: descriptor.inputSchema,
        }
      : undefined;
  }
  return params.registeredTools.find((tool) => tool.name === HEARTBEAT_RESPONSE_TOOL_NAME);
}

export function selectInactiveCodexHeartbeatResponseTool(params: {
  descriptor: InactiveCodexHeartbeatResponseDescriptor;
  disableTools?: boolean;
  toolsAllow?: string[];
  pluginConfig: Pick<CodexPluginConfig, "codexDynamicToolsExclude">;
}): AnyAgentTool | undefined {
  if (params.disableTools) {
    return undefined;
  }
  const descriptor = params.descriptor;
  if (descriptor.name !== HEARTBEAT_RESPONSE_TOOL_NAME) {
    throw new Error(`Expected ${HEARTBEAT_RESPONSE_TOOL_NAME}, received ${descriptor.name}`);
  }
  const tool: AnyAgentTool = {
    name: descriptor.name,
    label: descriptor.name,
    description: descriptor.description,
    // The no-op fallback must validate the exact declaration already accepted by Codex.
    parameters: descriptor.parameters,
    execute: async (_toolCallId, args) => {
      const response = normalizeHeartbeatToolResponse(args);
      if (!response) {
        throw new Error(
          "Invalid heartbeat response. Provide outcome, notify, and non-empty summary.",
        );
      }
      if (response.notify) {
        throw new Error("heartbeat_respond cannot send notifications outside a heartbeat turn");
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "No heartbeat is active for this turn. Continue the current task and respond normally.",
          },
        ],
        details: { status: "ignored", reason: "non-heartbeat-turn" },
      };
    },
  };

  const allowed = applyEmbeddedAttemptToolsAllow([tool], params.toolsAllow);
  return filterCodexDynamicTools(allowed, params.pluginConfig)[0];
}
