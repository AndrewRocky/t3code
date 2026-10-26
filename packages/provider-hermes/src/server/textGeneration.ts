import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { TextGenerationError } from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import type { HermesSettings } from "../settings.ts";
import { buildHermesAcpSpawnInput, resolveHermesAcpBaseModelId } from "./acpSupport.ts";

const HERMES_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Each request is a session in the shared Hermes daemon, so it shows up in
 * Hermes' own history like any editor session. No MCP servers are passed.
 */
export const makeHermesTextGeneration = Effect.fn("makeHermesTextGeneration")(function* (
  settings: HermesSettings,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runHermesJson: TextGenerationOperations.Runner = Effect.fn(
    "HermesTextGeneration.runHermesJson",
  )(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const outputRef = yield* Ref.make("");
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          cwd,
          clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
          mcpServers: [],
          spawn: buildHermesAcpSpawnInput({
            settings,
            cwd,
            environment,
            homeDirectory,
            yolo: false,
          }),
        }),
      ).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        // Command replies carry no messageId; only the model's reply is output.
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const text = update.content.text;
        return Ref.update(outputRef, (current) => current + text);
      });

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        const requested = resolveHermesAcpBaseModelId(modelSelection.model);
        const current = started.sessionSetupResult.models?.currentModelId;
        if (requested !== undefined && requested !== current) {
          yield* started.modelConfigId === undefined
            ? runtime.setSessionModel(requested)
            : runtime.setConfigOption(started.modelConfigId, requested);
        }
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(HERMES_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Hermes ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({ operation, detail: "Hermes ACP request failed.", cause }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Hermes ACP request was cancelled."
              : "Hermes returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Hermes", trimmed);
    },
    (effect, request) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "Hermes ACP text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );

  return TextGenerationOperations.fromRunner(
    "HermesTextGeneration",
    TextGenerationOperations.withoutInvestigation("Hermes", runHermesJson),
  );
});
