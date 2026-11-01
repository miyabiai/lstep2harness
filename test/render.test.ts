import { describe, expect, it } from "vitest";
import { chunkStatements } from "../src/sql/render.js";

describe("chunkStatements", () => {
  it("同じ group の文は、文数の上限を越えても同じファイルに入れる（途中で止まっても半端にしない）", () => {
    const statements = [
      ...Array.from({ length: 3 }, (_, i) => ({ sql: `S${i};` })),
      ...Array.from({ length: 4 }, (_, i) => ({ sql: `A${i};`, group: "a" })),
      ...Array.from({ length: 2 }, (_, i) => ({ sql: `B${i};`, group: "b" })),
      { sql: "T;" },
    ];
    const chunks = chunkStatements(statements, "x", 4);
    expect(chunks.map((chunk) => chunk.statements)).toEqual([
      ["S0;", "S1;", "S2;"],
      ["A0;", "A1;", "A2;", "A3;"],
      ["B0;", "B1;", "T;"],
    ]);
    // group が無ければ従来どおり（文字列の配列も受ける）
    expect(chunkStatements(["1;", "2;", "3;"], "y", 2).map((chunk) => chunk.statements)).toEqual([["1;", "2;"], ["3;"]]);
  });
});
