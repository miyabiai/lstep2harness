import { describe, expect, it } from "vitest";
import { isStartEvent, restoreProgress } from "../src/mapping/scenario-progress.js";
import type { SourceMessage } from "../src/source/types.js";

const info = { name: "架空のシナリオ", steps: [] } as unknown as Parameters<typeof restoreProgress>[0];
const friendText: SourceMessage = { sender: "friend", message_type: "text", content: '{"scenario_name":"架空のシナリオ","start_day":1}', sent_at: "2026-10-01T00:00:00.000Z" };

describe("scenario progress", () => {
  it("does not treat a friend's JSON-looking text as a start record", () => {
    expect(isStartEvent(friendText, "架空のシナリオ")).toBe(false);
  });

  it("leaves progress unknown when no start record exists, even if history looks old enough", () => {
    expect(restoreProgress(info, [friendText], Date.parse("2026-10-02T00:00:00.000Z"))).toBeNull();
  });

  it("starts from the beginning only when a start record from the bot exists", () => {
    const start: SourceMessage = { sender: "bot", message_type: "scenario", content: '{"scenario_name":"架空のシナリオ","start_day":1}', sent_at: "2026-10-01T00:00:00.000Z" };
    expect(restoreProgress(info, [start], null)).toEqual({ lastIndex: -1, lastAt: null, matched: 0 });
  });
});
