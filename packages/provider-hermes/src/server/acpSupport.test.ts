import { describe, expect, it } from "vite-plus/test";

import {
  buildHermesAcpSpawnInput,
  hermesApprovalOptions,
  hermesLaunchRuntimeMode,
  resolveHermesAcpBaseModelId,
} from "./acpSupport.ts";

const settings = { binaryPath: "", homePath: "" };

describe("buildHermesAcpSpawnInput", () => {
  it("never inherits YOLO from the user's shell", () => {
    const supervised = buildHermesAcpSpawnInput({
      settings,
      cwd: "/repo",
      environment: { PATH: "/bin", HERMES_YOLO_MODE: "1" },
      homeDirectory: "/home/me",
      yolo: false,
    });
    expect(supervised.env).not.toHaveProperty("HERMES_YOLO_MODE");
    expect(supervised.args).toEqual(["acp"]);

    const fullAccess = buildHermesAcpSpawnInput({
      settings,
      cwd: "/repo",
      environment: { PATH: "/bin" },
      homeDirectory: "/home/me",
      yolo: true,
    });
    expect(fullAccess.env).toMatchObject({ HERMES_YOLO_MODE: "1" });
  });
});

describe("hermesLaunchRuntimeMode", () => {
  it("asks for everything when an approval or sandbox override is set", () => {
    expect(hermesLaunchRuntimeMode({ runtimeMode: "full-access" })).toBe("full-access");
    expect(
      hermesLaunchRuntimeMode({ runtimeMode: "full-access", approvalPolicy: "on-request" }),
    ).toBe("approval-required");
    expect(
      hermesLaunchRuntimeMode({ runtimeMode: "auto-accept-edits", sandboxPolicy: "read-only" }),
    ).toBe("approval-required");
  });
});

describe("resolveHermesAcpBaseModelId", () => {
  it("keeps the session's model for the default selection", () => {
    expect(resolveHermesAcpBaseModelId("default")).toBeUndefined();
    expect(resolveHermesAcpBaseModelId(undefined)).toBeUndefined();
  });

  it("lowercases only the provider half", () => {
    expect(resolveHermesAcpBaseModelId("OpenRouter:anthropic/Claude-Sonnet")).toBe(
      "openrouter:anthropic/Claude-Sonnet",
    );
    expect(resolveHermesAcpBaseModelId("Qwen3-Coder")).toBe("Qwen3-Coder");
  });
});

describe("hermesApprovalOptions", () => {
  const request = (options: ReadonlyArray<{ optionId: string; kind: string }>) =>
    ({
      sessionId: "s",
      toolCall: { toolCallId: "t" },
      options: options.map((option) => ({ ...option, name: option.optionId })),
    }) as unknown as Parameters<typeof hermesApprovalOptions>[0];

  it("offers the session grant only when Hermes' first always-option is session-scoped", () => {
    const gateway = request([
      { optionId: "allow_once", kind: "allow_once" },
      { optionId: "allow_session", kind: "allow_always" },
      { optionId: "allow_always", kind: "allow_always" },
      { optionId: "deny", kind: "reject_once" },
      { optionId: "deny_always", kind: "reject_always" },
    ]);
    expect(hermesApprovalOptions(gateway).map((option) => option.decision)).toEqual([
      "cancel",
      "decline",
      "acceptForSession",
      "accept",
    ]);

    const permanentOnly = request([
      { optionId: "allow_once", kind: "allow_once" },
      { optionId: "allow_always", kind: "allow_always" },
      { optionId: "deny", kind: "reject_once" },
    ]);
    expect(hermesApprovalOptions(permanentOnly).map((option) => option.decision)).toEqual([
      "cancel",
      "decline",
      "accept",
    ]);
  });
});
