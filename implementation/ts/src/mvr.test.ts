import { describe, expect, test } from "@jest/globals";
import { createLeftAndRight } from "./helpers";
import { OpId, Picomerge } from "./picomerge";

describe("OpId", () => {
  describe("compare", () => {
    const a = OpId.create(1, "a");
    test("same Lampstamp, same tie breaker (identity)", () => {
      expect(OpId.compare(a, a)).toBe(0);
    });

    const b = OpId.create(1, "b");
    test("same Lampstamp, different tie breaker (lexicographic tie breaking)", () => {
      expect(OpId.compare(a, b)).toBe(-1);
      expect(OpId.compare(b, a)).toBe(1);
    });

    const c = OpId.create(2, "a");
    test("different Lampstamp, same tie breaker (ignore tie breaker)", () => {
      expect(OpId.compare(a, c)).toBe(-1);
      expect(OpId.compare(c, a)).toBe(1);
    });

    const d = OpId.create(2, "b");
    test("different Lampstamp, larger tie breaker (ignore tie breaker)", () => {
      expect(OpId.compare(a, d)).toBe(-1);
      expect(OpId.compare(d, a)).toBe(1);
    });

    const e = OpId.create(3, "a");
    test("different Lampstamp, smaller tie breaker (ignore tie breaker)", () => {
      expect(OpId.compare(d, e)).toBe(-1);
      expect(OpId.compare(e, d)).toBe(1);
    });
  });
});

describe("Picomerge: get, set and delete without undo and redo", () => {
  test("linear get and set and delete", () => {
    const { left, right } = createLeftAndRight<number>();

    right.apply([left.set(1)]);
    expect([left.get(), right.get()]).toEqual([[1], [1]]);

    left.apply([right.set(2)]);
    expect([left.get(), right.get()]).toEqual([[2], [2]]);

    right.apply([left.delete()]);
    expect([left.get(), right.get()]).toEqual([[], []]);
  });

  test("idempotence of operations", () => {
    const instance = Picomerge.create<number>("test");

    const ops = [instance.set(1), instance.delete(), instance.set(2)];
    expect(instance.get()).toEqual([2]);

    // we only reapply set(1) and delete() and they do not produce an effect
    instance.apply(ops.slice(0, 2));
    expect(instance.get()).toEqual([2]);
  });

  test("concurrent get and set", () => {
    const { left, right } = createLeftAndRight<number>();

    // initial state check
    expect([left.get(), right.get()]).toEqual([[], []]);

    const leftOps = [left.set(1), left.set(3)];
    expect(left.get()).toEqual([3]);

    const rightOps = [right.set(2)];
    expect(right.get()).toEqual([2]);

    // apply left ops to right (should have an effect)
    right.apply(leftOps);
    expect([left.get(), right.get()]).toEqual([[3], [3, 2]]);

    // apply right ops to left (should align both replicas)
    left.apply(rightOps);
    expect([left.get(), right.get()]).toEqual([
      [3, 2],
      [3, 2],
    ]);
  });

  test("concurrent set and delete", () => {
    const { left, right } = createLeftAndRight<number>();

    const leftOps = [left.set(1), left.delete()];
    expect(left.get()).toEqual([]);

    const rightOps = [right.set(2)];
    expect(right.get()).toEqual([2]);

    // apply left ops to right (should have an effect)
    right.apply(leftOps);
    expect([left.get(), right.get()]).toEqual([[], [2]]);

    // apply right ops to left (should align both replicas)
    left.apply(rightOps);
    expect([left.get(), right.get()]).toEqual([[2], [2]]);

    // any subsequent op should have an effect on both left and right
    // and merge both registers to a single value ("merge commit")
    left.apply([right.set(1)]);
    expect([left.get(), right.get()]).toEqual([[1], [1]]);
  });

  test("operations are deferred until causally ready (out of order delivery of operations)", () => {
    const { left, right } = createLeftAndRight<number>();

    const leftOps = [left.set(1), left.set(2), left.set(3)];

    // this operation should be put into the lobby until its pred (the first op)
    // is applied
    right.apply([leftOps[1]]);
    expect(right.get()).toEqual([]);

    // this operation has its direct pred in the lobby but not yet applied
    // because its pred is not yet causally ready (transitive check)
    right.apply([leftOps[2]]);
    expect(right.get()).toEqual([]);

    // the first operation was deferring both the second and transitively the
    // third operation: now all three should be applied all at once
    right.apply([leftOps[0]]);
    expect(right.get()).toEqual([3]);
  });
});
