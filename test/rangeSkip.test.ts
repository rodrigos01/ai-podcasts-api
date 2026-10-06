import { describe, expect, it } from "vitest";
import { createByteSkipper } from "../src/utils/rangeSkip";

function collect(skip: number, inputs: number[][]): number[] {
  const out: number[] = [];
  const write = createByteSkipper(skip, (b) => out.push(...b));
  for (const input of inputs) write(Buffer.from(input));
  return out;
}

describe("createByteSkipper", () => {
  it("passes everything through when skipping 0 bytes", () => {
    expect(collect(0, [[1, 2], [3]])).toEqual([1, 2, 3]);
  });

  it("drops whole buffers and trims the one that straddles the boundary", () => {
    expect(collect(3, [[1, 2], [3, 4, 5], [6]])).toEqual([4, 5, 6]);
  });

  it("drops everything when fewer bytes than the skip arrive", () => {
    expect(collect(10, [[1, 2], [3]])).toEqual([]);
  });

  it("does not forward empty buffers", () => {
    let calls = 0;
    const write = createByteSkipper(0, () => calls++);
    write(Buffer.alloc(0));
    expect(calls).toBe(0);
  });
});
