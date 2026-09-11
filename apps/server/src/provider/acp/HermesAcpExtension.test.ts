import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  hermesUpdateCarriesCompactionSummary,
  parseHermesSessionInfo,
  parseHermesSessionProvenance,
  parseHermesUsageUpdate,
} from "./HermesAcpExtension.ts";

type SessionUpdate = EffectAcpSchema.SessionNotification["update"];

const textChunk: SessionUpdate = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "hello" },
};

describe("parseHermesUsageUpdate", () => {
  it("maps context size and usage onto the token-usage snapshot", () => {
    assert.deepStrictEqual(
      parseHermesUsageUpdate({ sessionUpdate: "usage_update", size: 272000, used: 4096 }),
      { usedTokens: 4096, maxTokens: 272000, compactsAutomatically: true },
    );
  });

  it("drops a zero context size", () => {
    // `maxTokens` is a positive int; a provider with an unknown context
    // length reports 0, which must not reach the schema.
    assert.deepStrictEqual(
      parseHermesUsageUpdate({ sessionUpdate: "usage_update", size: 0, used: 10 }),
      { usedTokens: 10, compactsAutomatically: true },
    );
  });

  it("floors a fractional estimate", () => {
    // `estimate_request_tokens_rough` is an estimate, and JSON has no ints.
    assert.deepStrictEqual(
      parseHermesUsageUpdate({ sessionUpdate: "usage_update", size: 1000.5, used: 12.9 }),
      { usedTokens: 12, maxTokens: 1000, compactsAutomatically: true },
    );
  });

  it("rejects a negative usage rather than emitting an invalid snapshot", () => {
    assert.isUndefined(
      parseHermesUsageUpdate({ sessionUpdate: "usage_update", size: 100, used: -1 }),
    );
  });

  it("marks Hermes as compacting automatically", () => {
    // Asserted, not read from the wire: `UsageUpdate` carries only
    // size/used, and this flag is what makes the context popover say so.
    // The threshold stays absent because Hermes does not send it.
    const usage = parseHermesUsageUpdate({
      sessionUpdate: "usage_update",
      size: 128000,
      used: 1,
    });
    assert.isTrue(usage?.compactsAutomatically);
    assert.isUndefined(usage?.autoCompactThreshold);
  });

  it("ignores unrelated updates", () => {
    assert.isUndefined(parseHermesUsageUpdate(textChunk));
  });
});

describe("parseHermesSessionProvenance", () => {
  it("extracts the lineage Hermes attaches under _meta.hermes", () => {
    assert.deepStrictEqual(
      parseHermesSessionProvenance({
        _meta: {
          hermes: {
            sessionProvenance: {
              acpSessionId: "acp-1",
              currentHermesSessionId: "hermes-2",
              rootHermesSessionId: "hermes-1",
              previousHermesSessionId: "hermes-1",
              sessionKind: "continuation",
              reason: "compression",
              compressionDepth: 1,
            },
          },
        },
      }),
      {
        acpSessionId: "acp-1",
        currentHermesSessionId: "hermes-2",
        rootHermesSessionId: "hermes-1",
        previousHermesSessionId: "hermes-1",
        sessionKind: "continuation",
        reason: "compression",
        compressionDepth: 1,
      },
    );
  });

  it("returns undefined for a foreign or empty _meta bag", () => {
    assert.isUndefined(parseHermesSessionProvenance({}));
    assert.isUndefined(parseHermesSessionProvenance({ _meta: { other: { x: 1 } } }));
    assert.isUndefined(parseHermesSessionProvenance({ _meta: { hermes: {} } }));
    assert.isUndefined(
      parseHermesSessionProvenance({ _meta: { hermes: { sessionProvenance: {} } } }),
    );
  });

  it("skips fields of the wrong shape instead of failing the whole payload", () => {
    assert.deepStrictEqual(
      parseHermesSessionProvenance({
        _meta: {
          hermes: {
            sessionProvenance: {
              currentHermesSessionId: "hermes-2",
              sessionKind: 7,
              compressionDepth: "deep",
            },
          },
        },
      }),
      { currentHermesSessionId: "hermes-2" },
    );
  });
});

describe("parseHermesSessionInfo", () => {
  it("returns a title-only update", () => {
    assert.deepStrictEqual(
      parseHermesSessionInfo({
        sessionUpdate: "session_info_update",
        title: "Refactor the parser",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      { title: "Refactor the parser", updatedAt: "2026-01-01T00:00:00Z" },
    );
  });

  it("returns provenance from a compaction rotation", () => {
    const parsed = parseHermesSessionInfo({
      sessionUpdate: "session_info_update",
      _meta: {
        hermes: { sessionProvenance: { currentHermesSessionId: "hermes-2", compressionDepth: 1 } },
      },
    });
    assert.equal(parsed?.provenance?.currentHermesSessionId, "hermes-2");
  });

  it("ignores a bare timestamp refresh", () => {
    // No title and no provenance means nothing changed that a client can
    // render, so thread metadata must not churn.
    assert.isUndefined(
      parseHermesSessionInfo({
        sessionUpdate: "session_info_update",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
  });

  it("ignores unrelated updates", () => {
    assert.isUndefined(parseHermesSessionInfo(textChunk));
  });
});

describe("hermesUpdateCarriesCompactionSummary", () => {
  it("recognises both markers Hermes sets on replayed history", () => {
    assert.isTrue(
      hermesUpdateCarriesCompactionSummary({
        ...textChunk,
        _meta: { hermes: { compactionSummary: true } },
      }),
    );
    assert.isTrue(
      hermesUpdateCarriesCompactionSummary({
        ...textChunk,
        _meta: { hermes: { containsCompactionSummary: true } },
      }),
    );
    assert.isFalse(hermesUpdateCarriesCompactionSummary(textChunk));
  });
});
