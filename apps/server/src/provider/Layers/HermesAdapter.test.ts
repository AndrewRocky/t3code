// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  hermesApprovalKey,
  hermesPromptSettlementBelongsToContext,
  hermesProvenanceFingerprint,
  makeHermesAdapter,
  selectHermesPermissionOptionId,
} from "./HermesAdapter.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockHermesWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-hermes.sh");
  const envExports = Object.entries({ T3_ACP_HERMES: "1", ...extraEnv })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

/** Hermes' five permission options, as `acp_adapter/permissions.py` emits them. */
const hermesPermissionRequest = {
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
    { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
    { optionId: "deny_always", name: "Deny always", kind: "reject_always" },
  ],
} as unknown as EffectAcpSchema.RequestPermissionRequest;

/** An edit approval: Hermes offers only these two and approves on `allow_once`. */
const hermesEditApprovalRequest = {
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
} as unknown as EffectAcpSchema.RequestPermissionRequest;

describe("selectHermesPermissionOptionId", () => {
  it("maps each decision onto the option Hermes expects", () => {
    assert.equal(selectHermesPermissionOptionId(hermesPermissionRequest, "accept"), "allow_once");
    // `allow_session` and `allow_always` share the ACP kind `allow_always`, so
    // matching on kind alone cannot tell session scope from permanent scope.
    assert.equal(
      selectHermesPermissionOptionId(hermesPermissionRequest, "acceptForSession"),
      "allow_session",
    );
    assert.equal(
      selectHermesPermissionOptionId(hermesPermissionRequest, "acceptAlways"),
      "allow_always",
    );
    assert.equal(selectHermesPermissionOptionId(hermesPermissionRequest, "decline"), "deny");
  });

  it("degrades a session-scoped accept to allow_once on an edit approval", () => {
    // Hermes' edit gate approves strictly on `allow_once`; without this
    // fallback "Always allow this session" on a file edit would silently deny.
    assert.equal(
      selectHermesPermissionOptionId(hermesEditApprovalRequest, "acceptForSession"),
      "allow_once",
    );
    assert.equal(
      selectHermesPermissionOptionId(hermesEditApprovalRequest, "acceptAlways"),
      "allow_once",
    );
  });

  it("falls back to the ACP kind when the ids are non-standard", () => {
    const request = {
      options: [
        { optionId: "vendor-allow", name: "Allow", kind: "allow_once" },
        { optionId: "vendor-reject", name: "Reject", kind: "reject_once" },
      ],
    } as unknown as EffectAcpSchema.RequestPermissionRequest;
    assert.equal(selectHermesPermissionOptionId(request, "accept"), "vendor-allow");
    assert.equal(selectHermesPermissionOptionId(request, "decline"), "vendor-reject");
  });

  it("returns undefined when nothing matches", () => {
    const request = {
      options: [{ optionId: "only-deny", name: "Deny", kind: "reject_once" }],
    } as unknown as EffectAcpSchema.RequestPermissionRequest;
    assert.isUndefined(selectHermesPermissionOptionId(request, "accept"));
  });
});

describe("hermesApprovalKey", () => {
  it("keys on the operation, not the tool-call id", () => {
    const first = hermesApprovalKey({
      kind: "execute",
      title: "Terminal",
      rawInput: { command: "pnpm test" },
    });
    const second = hermesApprovalKey({
      kind: "execute",
      title: "Terminal",
      rawInput: { command: "pnpm test" },
    });
    assert.isDefined(first);
    assert.equal(first, second);
  });

  it("distinguishes different commands under the same tool", () => {
    assert.notEqual(
      hermesApprovalKey({ kind: "execute", title: "Terminal", rawInput: { command: "ls" } }),
      hermesApprovalKey({ kind: "execute", title: "Terminal", rawInput: { command: "rm -rf /" } }),
    );
  });

  it("declines to key a bare title with no input", () => {
    // A generic title cannot identify an operation, so approving it once must
    // not approve every future call of that tool.
    assert.isUndefined(hermesApprovalKey({ kind: "other", title: "Do a thing" }));
    assert.isUndefined(hermesApprovalKey({ kind: "other", title: "Do a thing", rawInput: {} }));
  });
});

describe("hermesProvenanceFingerprint", () => {
  it("changes when the internal session rotates", () => {
    assert.notEqual(
      hermesProvenanceFingerprint({ currentHermesSessionId: "h-1", compressionDepth: 0 }),
      hermesProvenanceFingerprint({ currentHermesSessionId: "h-2", compressionDepth: 1 }),
    );
  });

  it("is stable for a repeated lineage so a compaction is announced once", () => {
    assert.equal(
      hermesProvenanceFingerprint({ currentHermesSessionId: "h-2", compressionDepth: 1 }),
      hermesProvenanceFingerprint({ currentHermesSessionId: "h-2", compressionDepth: 1 }),
    );
  });

  it("is undefined when there is no provenance", () => {
    assert.isUndefined(hermesProvenanceFingerprint(undefined));
  });
});

describe("hermesPromptSettlementBelongsToContext", () => {
  const turnId = TurnId.make("11111111-1111-4111-8111-111111111111");
  const staleTurnId = TurnId.make("22222222-2222-4222-8222-222222222222");

  it("accepts a settlement for the live session and turn", () => {
    assert.isTrue(
      hermesPromptSettlementBelongsToContext({
        liveAcpSessionId: "session-a",
        expectedAcpSessionId: "session-a",
        liveActiveTurnId: turnId,
        liveSessionActiveTurnId: turnId,
        turnId,
      }),
    );
  });

  it("rejects a settlement from a replaced ACP session", () => {
    assert.isFalse(
      hermesPromptSettlementBelongsToContext({
        liveAcpSessionId: "session-b",
        expectedAcpSessionId: "session-a",
        liveActiveTurnId: turnId,
        liveSessionActiveTurnId: turnId,
        turnId,
      }),
    );
  });

  it("rejects a settlement for a superseded turn", () => {
    assert.isFalse(
      hermesPromptSettlementBelongsToContext({
        liveAcpSessionId: "session-a",
        expectedAcpSessionId: "session-a",
        liveActiveTurnId: turnId,
        liveSessionActiveTurnId: turnId,
        turnId: staleTurnId,
      }),
    );
  });
});

const hermesAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeHermesAdapter>[1]) =>
  makeHermesAdapter(decodeHermesSettings({ binaryPath, enabled: true }), options).pipe(
    Effect.orDie,
  );

it.layer(hermesAdapterTestLayer)("HermesAdapterLive", (it) => {
  it.effect("starts a session and maps the ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "nous:hermes-4-405b",
        },
      });

      assert.equal(session.provider, "hermes");
      assert.equal(session.model, "nous:hermes-4-405b");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((event) => event.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("applies the runtime mode through session/set_mode after the session starts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-mode-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-mode-log-")),
      );
      const modeLogPath = NodePath.join(tempDir, "modes.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_MODE_LOG_PATH: modeLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      // Hermes has no `--permission-mode` flag; the mode is session state, so
      // the mapping must arrive as a request rather than a spawn argument.
      const modeLog = yield* waitForFileContent(modeLogPath, 40, "dont_ask");
      assert.include(modeLog, "dont_ask");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not request a mode that already matches the runtime mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-mode-noop-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-mode-noop-log-")),
      );
      const modeLogPath = NodePath.join(tempDir, "modes.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_MODE_LOG_PATH: modeLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      // The mock starts in `default`, which is what `approval-required` maps to.
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.stopSession(threadId);

      const written = yield* Effect.tryPromise(() => NodeFSP.readFile(modeLogPath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      assert.equal(written.trim(), "");
    }),
  );

  it.effect("re-emits Hermes usage and session-info notifications as runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-metadata-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EMIT_HERMES_METADATA: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      // `AcpRuntimeModel` parses only the five shared turn-content events, so
      // these two reach the stream solely through the Hermes handler.
      const usage = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.isDefined(usage);
      if (usage?.type === "thread.token-usage.updated") {
        assert.equal(usage.payload.usage.usedTokens, 4096);
        assert.equal(usage.payload.usage.maxTokens, 272000);
        assert.isTrue(usage.payload.usage.compactsAutomatically);
      }

      const metadataEvents = runtimeEvents.filter(
        (event) => event.type === "thread.metadata.updated",
      );
      const titled = metadataEvents.find(
        (event) => event.type === "thread.metadata.updated" && event.payload.name !== undefined,
      );
      assert.isDefined(titled);
      if (titled?.type === "thread.metadata.updated") {
        assert.equal(titled.payload.name, "Mock Hermes session");
        assert.deepStrictEqual(titled.payload.metadata?.hermesSessionProvenance, {
          acpSessionId: "mock-session-1",
          currentHermesSessionId: "hermes-session-2",
          rootHermesSessionId: "hermes-session-1",
          previousHermesSessionId: "hermes-session-1",
          sessionKind: "continuation",
          reason: "compression",
          compressionDepth: 1,
        });
      }

      // `available_commands_update` is deliberately NOT forwarded: the mock
      // sends one, and no runtime event may carry it. Hermes' command list is
      // static per version, so `HermesProvider` advertises it on the snapshot
      // where the composer's slash menu actually reads it; the metadata bag
      // this used to populate is read by nothing.
      const commands = metadataEvents.find(
        (event) =>
          event.type === "thread.metadata.updated" &&
          event.payload.metadata?.hermesAvailableCommands !== undefined,
      );
      assert.isUndefined(commands);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves permission requests in full-access mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-auto-approve-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_HERMES_PERMISSION_OPTIONS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run something", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      // Hermes' session modes gate edits only — shell commands always ask — so
      // full-access must answer without opening a request in the UI.
      assert.isUndefined(runtimeEvents.find((event) => event.type === "request.opened"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      // Hermes implements no `session/close`, so teardown is scope closure —
      // the child process must actually die.
      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("rejects structured user input, which Hermes never requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-no-user-input");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const result = yield* adapter
        .respondToUserInput(
          threadId,
          // A request id that cannot exist: Hermes implements no ext methods.
          "00000000-0000-4000-8000-000000000000" as never,
          {},
        )
        .pipe(Effect.result);
      assert.isTrue(result._tag === "Failure");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects rollback, which Hermes cannot do", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-no-rollback");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      // `session/fork` branches forward from full history; there is no
      // truncating counterpart.
      const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
      assert.isTrue(rollback._tag === "Failure");

      const invalid = yield* adapter.rollbackThread(threadId, 0).pipe(Effect.result);
      assert.isTrue(invalid._tag === "Failure");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rewrites a `$skill` token into a skill_view directive on the wire", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-skill-directive-thread");
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-skill-home-")),
      );
      // Category-nested, as a real install is.
      const skillDir = NodePath.join(home, "skills", "productivity", "pdf");
      yield* Effect.promise(() => NodeFSP.mkdir(skillDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(skillDir, "SKILL.md"),
          ["---", "name: pdf", "description: Work with PDFs.", "---", "", "# Body"].join("\n"),
          "utf8",
        ),
      );

      const requestLogPath = NodePath.join(home, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeHermesAdapter(
        decodeHermesSettings({ binaryPath: wrapperPath, homePath: home, enabled: true }),
      ).pipe(Effect.orDie);

      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(turnCompleted, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "$pdf summarise this", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      const requests = yield* waitForFileContent(requestLogPath, 80, "session/prompt");
      const promptLine = requests.split("\n").findLast((line) => line.includes('"session/prompt"'));
      assert.isDefined(promptLine);
      const promptText = JSON.parse(promptLine ?? "{}").params.prompt[0].text as string;

      // The user's own token survives — the composer chip and the stored
      // message must still read the way they typed it.
      assert.isTrue(promptText.startsWith("$pdf summarise this"));
      assert.include(promptText, 'skill_view("pdf")');
      assert.include(promptText, "stop and tell the user");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("leaves a prompt with no skill token byte-identical", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-no-directive-thread");
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-skill-home-none-")),
      );
      const requestLogPath = NodePath.join(home, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeHermesAdapter(
        decodeHermesSettings({ binaryPath: wrapperPath, homePath: home, enabled: true }),
      ).pipe(Effect.orDie);

      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(turnCompleted, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "refactor the parser", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      const requests = yield* waitForFileContent(requestLogPath, 80, "session/prompt");
      const promptLine = requests.split("\n").findLast((line) => line.includes('"session/prompt"'));
      const promptText = JSON.parse(promptLine ?? "{}").params.prompt[0].text as string;
      assert.equal(promptText, "refactor the parser");

      yield* adapter.stopSession(threadId);
    }),
  );
});
