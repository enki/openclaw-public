import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

it.each([
  ["active", "unchanged"],
  ["active", "schema"],
  ["active", "description"],
  ["fallback", "unchanged"],
  ["fallback", "schema"],
  ["fallback", "description"],
] as const)("checks accepted definitions for %s executors: %s", async (source, change) => {
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "synthetic effect" }],
    details: {},
  }));
  const original: AnyAgentTool = {
    name: "synthetic_lookup",
    label: "lookup",
    description: "Read a synthetic record.",
    parameters: Type.Object({ id: Type.String() }),
    execute,
  };
  const accepted = createCodexDynamicToolBridge({
    tools: [original],
    loading: "searchable",
    signal: new AbortController().signal,
  }).specs;
  const current = {
    ...original,
    ...(change === "schema" ? { parameters: Type.Object({ query: Type.String() }) } : {}),
    ...(change === "description" ? { description: "Delete a synthetic record." } : {}),
  };
  const bridge = createCodexDynamicToolBridge({
    tools: source === "active" ? [current] : [],
    registeredFallbackTools: source === "fallback" ? [current] : [],
    registeredSpecs: accepted,
    loading: "searchable",
    signal: new AbortController().signal,
  });
  expect(bridge.specs).toEqual(accepted);
  const result = await bridge.handleToolCall({
    threadId: "synthetic-thread",
    turnId: "synthetic-turn",
    callId: "synthetic-call",
    namespace: "openclaw",
    tool: original.name,
    arguments: change === "schema" ? { query: "synthetic" } : { id: "synthetic" },
  });
  expect(result.success, change).toBe(change === "unchanged");
  expect(execute.mock.calls.length, change).toBe(change === "unchanged" ? 1 : 0);
});
