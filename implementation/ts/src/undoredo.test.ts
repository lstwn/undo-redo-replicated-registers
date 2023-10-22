import { describe, expect, test } from "@jest/globals";
import { createLeftAndRight } from "./helpers";
import { OpId, Picomerge } from "./picomerge";

describe("Picomerge: undo and redo", () => {
  describe("undo and redo tests", () => {
    test("undo and redo preconditions: allow only local ops to be undone and redone", () => {
      const { left, right } = createLeftAndRight<number>();

      // there is nothing to undo because there are no operations
      expect(left.undo()).toBeUndefined();

      // there is nothing to redo because there are no operations
      expect(left.redo()).toBeUndefined();

      const rightOps = [right.set(1), right.set(2)];
      left.apply(rightOps);

      // there is still nothing to undo because the received operations are foreign to left
      expect(left.undo()).toBeUndefined();

      // there is still nothing to redo because the received operations are foreign to left
      expect(left.redo()).toBeUndefined();
    });

    test("undo back until root state", () => {
      const a = Picomerge.create<number>("A");

      a.set(1);
      a.undo();

      expect(a.get()).toEqual([]);
    });

    test("redo stack is cleared once a later local terminal op happens", () => {
      const { left, right } = createLeftAndRight<number>();

      left.apply([
        right.set(1),
        right.set(2),
        right.set(3),
        right.undo(),
        right.undo(),
        // right's redo stack now holds two operations
      ]);
      expect([left.get(), right.get()]).toEqual([[1], [1]]);

      right.apply([left.set(4)]);
      expect([left.get(), right.get()]).toEqual([[4], [4]]);
      // redo possible because the set op above was a foreign set op and
      // the redo stack is non-empty
      left.apply([right.redo()]);
      expect([left.get(), right.get()]).toEqual([[2], [2]]);

      left.apply([right.set(5)]);
      // redo not possible anymore although there was one item on the redo stack left
      // but the set op cleared it
      expect(right.redo()).toBeUndefined();
    });

    test("undoing an operation undoes the last operation of that (same) actor", () => {
      const { left, right } = createLeftAndRight<number>();

      left.apply([right.set(1)]);
      const toBeUndoneOp = right.set(2);
      left.apply([toBeUndoneOp]);
      // this is an operation which is in between the to-be-undone op and the undo op
      // and is from the foreign actor (left)
      right.apply([left.set(3)]);

      expect([left.get(), right.get()]).toEqual([[3], [3]]);

      const undoOp = right.undo()!;
      expect(undoOp.anchor).toEqual(toBeUndoneOp.opId);
      expect(right.get()).toEqual([1]);
    });

    test("single actor undo and redo", () => {
      const a = Picomerge.create<number>("A");

      a.set(0);
      a.set(1);
      a.set(2);
      a.set(3);
      a.set(4);

      expect(a.get()).toEqual([4]);
      a.undo();
      expect(a.get()).toEqual([3]);
      a.undo();
      expect(a.get()).toEqual([2]);
      a.undo();
      expect(a.get()).toEqual([1]);
      a.undo();
      expect(a.get()).toEqual([0]);
      a.undo();
      expect(a.get()).toEqual([]);
      expect(a.undo()).toBeUndefined();

      a.redo();
      expect(a.get()).toEqual([0]);
      a.redo();
      expect(a.get()).toEqual([1]);
      a.redo();
      expect(a.get()).toEqual([2]);
      a.redo();
      expect(a.get()).toEqual([3]);
      a.redo();
      expect(a.get()).toEqual([4]);
      expect(a.redo()).toBeUndefined();
    });

    test("linear operation history: N times undo and N times redo (does not produce a high resolution depth)", () => {
      const a = Picomerge.create<number>("A");

      a.set(0);
      a.set(1);
      expect(a.get()).toEqual([1]);

      const N = 10;

      Array.from({ length: N }).map((_, i) => {
        a.set(i);
        expect(a.get()).toEqual([i]);
        expect(
          a.terminalHeads().map(([_op, meta]) => meta.resolutionDepth),
        ).toEqual([1]); // set ops have constant resolution depth
      });

      Array.from({ length: N - 1 })
        .map((_, i) => i)
        .reverse()
        .map((i) => {
          expect(a.undo()).toBeDefined();
          expect(a.get()).toEqual([i]);
          expect(
            a.terminalHeads().map(([_op, meta]) => meta.resolutionDepth),
          ).toEqual([2]); // undo has constant resolution depth
        });

      expect(a.get()).toEqual([0]);

      const redoResolutionDepths: number[] = [];
      Array.from({ length: N - 1 }).map((_, i) => {
        expect(a.redo()).toBeDefined();
        expect(a.get()).toEqual([i + 1]);
        redoResolutionDepths.push(
          ...a.terminalHeads().map(([_op, meta]) => meta.resolutionDepth),
        );
      });
      // all redo ops have constant resolution depth, too.
      expect(Math.max(...redoResolutionDepths)).toEqual(3);
    });

    test("linear operation history: undo and redo alternating sequence (produces high resolution depth)", () => {
      const a = Picomerge.create<number>("A");

      a.set(0);
      a.set(1);
      expect(a.get()).toEqual([1]);

      const length = 10;

      Array.from({ length }).map((_, i) => {
        const currentSeqLength = i + 1;

        expect(a.undo()).toBeDefined();
        expect(a.get()).toEqual([0]);
        expect(
          a.terminalHeads().map(([_op, meta]) => meta.resolutionDepth),
        ).toEqual([2]); // undo has constant resolution depth

        expect(a.redo()).toBeDefined();
        expect(a.get()).toEqual([1]);
        expect(
          a.terminalHeads().map(([_op, meta]) => meta.resolutionDepth),
        ).toEqual([currentSeqLength + 1]); // redo is not constant, but linearly increasing
      });
    });

    test("linear operation history: set and undo alternating sequence (produces high resolution depth)", () => {
      const a = Picomerge.create<number>("A");

      const initValue = 0;
      a.set(initValue);

      const length = 10;

      Array.from({ length }).map((_, i) => {
        const currentSeqLength = i + 1;

        a.set(i);
        expect(a.get()).toEqual([i]);
        expect(
          a.terminalHeads().map(([_op, meta]) => meta.resolutionDepth),
        ).toEqual([1]); // set ops have constant resolution depth

        expect(a.undo()).toBeDefined();
        expect(a.get()).toEqual([initValue]);
        expect(
          a.terminalHeads().map(([_op, meta]) => meta.resolutionDepth),
        ).toEqual([currentSeqLength + 1]); // undo has non-constant resolution depth in this case, too
      });
    });

    test("undo recovers the state of the previous _local_ operation given a _linear_ history", () => {
      // as per Martin's video of Google Sheets behavior
      const { left, right } = createLeftAndRight<number>();

      left.apply([right.set(0)]);
      right.apply([left.set(1)]);
      left.apply([right.set(2)]);
      right.apply([left.set(3)]);
      left.apply([right.set(4)]);

      // both left and right now are perfectly synced and their editing history
      // is linear due to their ping pong exchange of edits
      expect([left.get(), right.get()]).toEqual([[4], [4]]);

      // first undo
      left.apply([right.undo()]);
      expect([left.get(), right.get()]).toEqual([[3], [3]]);

      // second undo
      left.apply([right.undo()]);
      expect([left.get(), right.get()]).toEqual([[1], [1]]);

      // first redo
      left.apply([right.redo()]);
      expect([left.get(), right.get()]).toEqual([[3], [3]]);

      // second redo
      left.apply([right.redo()]);
      expect([left.get(), right.get()]).toEqual([[4], [4]]);

      // no more redo possible
      expect(right.redo()).toBeUndefined();
      expect(left.redo()).toBeUndefined();
    });

    test("undo recovers the state of the previous _local_ operation given a _non-linear_ history", () => {
      const { left, right } = createLeftAndRight<number>();

      right.apply([left.set(1)]);

      const rightOp = right.set(2);
      const leftOp = left.set(3);

      right.apply([leftOp]);
      left.apply([rightOp]);

      expect([left.get(), right.get()]).toEqual([
        [2, 3],
        [2, 3],
      ]);

      // perform a merge op
      left.apply([right.set(4)]);
      // this in-between foreign-to-right op is also reverted when right undoes later
      right.apply([left.set(5)]);
      right.apply([left.set(6)]);

      expect([left.get(), right.get()]).toEqual([[6], [6]]);

      // both left and right now are perfectly synced

      const undoOp = right.undo()!;
      expect(right.get()).toEqual([2, 3]);
      left.apply([undoOp]);
      expect(left.get()).toEqual([2, 3]);

      left.apply([right.undo()]);
      expect([left.get(), right.get()]).toEqual([[1], [1]]);

      const redoOp = right.redo()!;
      expect(right.get()).toEqual([2, 3]);
      left.apply([redoOp]);
      expect(left.get()).toEqual([2, 3]);

      left.apply([right.redo()]);
      expect([left.get(), right.get()]).toEqual([[6], [6]]);
    });

    test("concurrent undo", () => {
      // this tests the case where an undo skips foreign ops and one of these
      // skipped ops is undone by its actor concurrently
      const { left, right } = createLeftAndRight<number>();

      left.apply([right.set(0)]);
      left.apply([right.set(1)]);
      right.apply([left.set(2)]); // this op is undone by only right
      right.apply([left.set(3)]); // this op is undone by both concurrently

      const concRightUndo = right.undo()!;
      const concLeftUndo = left.undo()!;

      expect(OpId.compare(concLeftUndo.opId, concRightUndo.opId)).toBe(-1);

      expect(right.get()).toEqual([0]);
      expect(left.get()).toEqual([2]);

      right.apply([concLeftUndo]);
      left.apply([concRightUndo]);

      expect([left.get(), right.get()]).toEqual([
        [0, 2],
        [0, 2],
      ]);

      right.apply([left.undo()!]);
      expect([left.get(), right.get()]).toEqual([[1], [1]]);
    });

    test("undo and redo with inverse operations", () => {
      // an undo of a set op can be like a redo of a delete op
      {
        const { left, right } = createLeftAndRight<number>();

        left.apply([right.set(1)]);
        right.apply([left.delete()]);
        right.apply([left.undo()]);

        expect([left.get(), right.get()]).toEqual([[1], [1]]);

        const rightUndo = right.undo()!;
        expect(right.get()).toEqual([]);
        const leftRedo = left.redo()!;
        expect(left.get()).toEqual([]);

        right.apply([leftRedo]);
        left.apply([rightUndo]);
        expect([left.get(), right.get()]).toEqual([[], []]);
      }

      // a redo of a set op can be like an undo of a delete op
      {
        // an undo of a set can be like a delete
        const { left, right } = createLeftAndRight<number>();

        left.apply([right.set(1)]);

        const rightOps = [right.undo()];
        expect(right.get()).toEqual([]);

        const leftOps = [left.delete()];
        expect(left.get()).toEqual([]);

        left.apply(rightOps);
        right.apply(leftOps);
        expect([left.get(), right.get()]).toEqual([[], []]);
      }
    });

    test("different undos/redos resolve to the same terminal operation (may create duplicates)", () => {
      const a = Picomerge.create<number>("A");
      const b = Picomerge.create<number>("B");
      const c = Picomerge.create<number>("C");

      const sharedOps = [a.set(1)];
      b.apply(sharedOps);
      c.apply(sharedOps);
      expect([a.get(), b.get(), c.get()]).toEqual([[1], [1], [1]]);

      const concurrentOpsA = [a.undo(), a.redo()];
      expect(concurrentOpsA[1]?.opId).toEqual([3, "A"]);
      expect(a.get()).toEqual([1]);

      const concurrentOpsB = [b.set(3), b.set(4)];
      expect(concurrentOpsB[1]?.opId).toEqual([3, "B"]);
      expect(b.get()).toEqual([4]);

      const concurrentOpsC = [c.set(2), c.undo()];
      expect(concurrentOpsC[1]?.opId).toEqual([3, "C"]);
      expect(c.get()).toEqual([1]);

      a.apply([...concurrentOpsB, ...concurrentOpsC]);
      b.apply([...concurrentOpsC, ...concurrentOpsA]);
      c.apply([...concurrentOpsA, ...concurrentOpsB]);

      expect([a.get(), b.get(), c.get()]).toEqual([
        // 1 is appearing twice because A's redo and C's undo both resolve to
        // A's set(1) op
        [1, 4, 1],
        [1, 4, 1],
        [1, 4, 1],
      ]);
      const opIdTraces = [["3@C", "1@A"], ["3@B"], ["3@A", "1@A"]];
      expect(a.terminalHeads().map(([_op, meta]) => meta.opIdTrace)).toEqual(
        opIdTraces,
      );
      expect(b.terminalHeads().map(([_op, meta]) => meta.opIdTrace)).toEqual(
        opIdTraces,
      );
      expect(c.terminalHeads().map(([_op, meta]) => meta.opIdTrace)).toEqual(
        opIdTraces,
      );
    });

    test("different undos/redos resolve to the same terminal operation via another shared undo/redo operation on their paths (may create duplicates)", () => {
      const a = Picomerge.create<number>("A");
      const b = Picomerge.create<number>("B");
      const c = Picomerge.create<number>("C");

      const sharedOps = [a.set(1), a.undo(), a.redo()];
      b.apply(sharedOps);
      c.apply(sharedOps);
      expect([a.get(), b.get(), c.get()]).toEqual([[1], [1], [1]]);

      const concurrentOpsA = [a.undo(), a.redo()];
      expect(concurrentOpsA[1]?.opId).toEqual([5, "A"]);
      expect(a.get()).toEqual([1]);

      const concurrentOpsB = [b.set(2), b.set(3)];
      expect(concurrentOpsB[1]?.opId).toEqual([5, "B"]);
      expect(b.get()).toEqual([3]);

      const concurrentOpsC = [c.set(2), c.undo()];
      expect(concurrentOpsC[1]?.opId).toEqual([5, "C"]);
      expect(c.get()).toEqual([1]);

      a.apply([...concurrentOpsB, ...concurrentOpsC]);
      b.apply([...concurrentOpsC, ...concurrentOpsA]);
      c.apply([...concurrentOpsA, ...concurrentOpsB]);

      expect([a.get(), b.get(), c.get()]).toEqual([
        // 1 is appearing twice because A's redo and C's undo both resolve to
        // A's set(1) op
        [1, 3, 1],
        [1, 3, 1],
        [1, 3, 1],
      ]);
      const opIdTraces = [
        ["5@C", "3@A", "1@A"],
        ["5@B"],
        ["5@A", "3@A", "1@A"],
      ];
      expect(a.terminalHeads().map(([_op, meta]) => meta.opIdTrace)).toEqual(
        opIdTraces,
      );
      expect(b.terminalHeads().map(([_op, meta]) => meta.opIdTrace)).toEqual(
        opIdTraces,
      );
      expect(c.terminalHeads().map(([_op, meta]) => meta.opIdTrace)).toEqual(
        opIdTraces,
      );
    });

    test("figure 3 from paper but with concurrent redo at step (5)", () => {
      const { left: a, right: b } = createLeftAndRight<number>("A", "B");

      a.apply([b.set(1)]);
      b.apply([a.set(2)]);

      const concurrentSetB = b.set(4);
      const concurrentSetA = a.set(3);
      a.apply([concurrentSetB]);
      b.apply([concurrentSetA]);

      b.apply([a.set(5)]);

      expect([a.get(), b.get()]).toEqual([[5], [5]]);

      const cuncurrentUndoA = a.undo()!;
      const concurrentUndoB = b.undo()!;
      expect([a.get(), b.get()]).toEqual([[4, 3], [2]]);

      a.apply([concurrentUndoB]);
      b.apply([cuncurrentUndoA]);
      expect([a.get(), b.get()]).toEqual([
        [2, 4, 3],
        [2, 4, 3],
      ]);

      b.apply([a.undo()]);
      expect([a.get(), b.get()]).toEqual([[2], [2]]);

      b.apply([a.undo()]);
      expect([a.get(), b.get()]).toEqual([[1], [1]]);

      expect(a.undo()).toBeUndefined();

      b.apply([a.redo()]);
      expect([a.get(), b.get()]).toEqual([[2], [2]]);

      const concurrentRedoA = a.redo()!;
      const concurrentRedoB = b.redo()!;
      expect([a.get(), b.get()]).toEqual([[2, 4, 3], [5]]);

      b.apply([concurrentRedoA]);
      a.apply([concurrentRedoB]);
      expect([a.get(), b.get()]).toEqual([
        [5, 2, 4, 3],
        [5, 2, 4, 3],
      ]);

      b.apply([a.redo()]);
      expect([a.get(), b.get()]).toEqual([[5], [5]]);

      expect(a.redo()).toBeUndefined();

      a.apply([b.set(6)]);
      expect([a.get(), b.get()]).toEqual([[6], [6]]);

      expect(b.redo()).toBeUndefined();
    });
  });

  describe("scenarios from the paper", () => {
    const color = {
      black: "black",
      red: "red",
      green: "green",
    } as const;

    test("figure 1 (lower scenario)", () => {
      const { left: a, right: b } = createLeftAndRight<string>("A", "B");

      // initial state
      b.apply([a.set(color.black)]);

      // user A's coloring to red
      b.apply([a.set(color.red)]);

      // user B's coloring to green
      a.apply([b.set(color.green)]);

      expect([a.get(), b.get()]).toEqual([[color.green], [color.green]]);

      // user A's undo
      b.apply([a.undo()]);

      // goes back to black
      expect([a.get(), b.get()]).toEqual([[color.black], [color.black]]);

      // user A's redo
      b.apply([a.redo()]);

      // goes forward to green
      expect([a.get(), b.get()]).toEqual([[color.green], [color.green]]);
    });

    test("figure 2", () => {
      const { left: a, right: b } = createLeftAndRight<number>("A", "B");

      b.apply([a.set(1)]);
      a.apply([b.set(2)]);

      // step (1)
      expect([a.get(), b.get()]).toEqual([[2], [2]]);

      const concurrentSetA = a.set(3);
      expect(concurrentSetA.opId).toEqual([3, "A"]);
      // step (2a)
      expect(a.get()).toEqual([3]);

      const concurrentSetB = b.set(4);
      expect(concurrentSetB.opId).toEqual([3, "B"]);
      // step (2b)
      expect(b.get()).toEqual([4]);

      a.apply([concurrentSetB]);
      b.apply([concurrentSetA]);
      // step (3)
      expect([a.get(), b.get()]).toEqual([
        [4, 3],
        [4, 3],
      ]);

      const finalDeleteA = a.delete()!;
      expect(finalDeleteA.opId).toEqual([4, "A"]);
      b.apply([finalDeleteA]);

      // step (4)
      expect([a.get(), b.get()]).toEqual([[], []]);
    });

    test("figure 3", () => {
      const { left: a, right: b } = createLeftAndRight<number>("A", "B");

      b.apply([a.set(1)]);
      a.apply([b.set(2)]);

      let concurrentSetA = a.set(4);
      const concurrentSetB = b.set(3);
      b.apply([concurrentSetA]);
      a.apply([concurrentSetB]);

      a.apply([b.set(5)]);

      // step (1) in paper
      expect([a.get(), b.get()]).toEqual([[5], [5]]);
      expect(a.undoStack().map((op) => op.opId)).toEqual([
        [1, "A"],
        [3, "A"],
      ]);
      expect(a.redoStack()).toEqual([]);
      expect(b.undoStack().map((op) => op.opId)).toEqual([
        [2, "B"],
        [3, "B"],
        [4, "B"],
      ]);
      expect(b.redoStack()).toEqual([]);

      const concurrentUndoA = a.undo()!;
      let concurrentUndoB = b.undo()!;
      // step (2a) in paper (before sync)
      expect([a.get(), b.get()]).toEqual([[2], [3, 4]]);
      expect(a.undoStack().map((op) => op.opId)).toEqual([[1, "A"]]);
      expect(a.redoStack().map((op) => op.opId)).toEqual([[5, "A"]]);
      expect(b.undoStack().map((op) => op.opId)).toEqual([
        [2, "B"],
        [3, "B"],
      ]);
      expect(b.redoStack().map((op) => op.opId)).toEqual([[5, "B"]]);
      const opIdTraceOf2 = a
        .terminalHeads()
        .map(([_op, meta]) => meta.opIdTrace)[0];
      const opIdTracesOfB = b
        .terminalHeads()
        .map(([_op, meta]) => meta.opIdTrace);
      const opIdTraceOf3 = opIdTracesOfB[0];
      const opIdTraceOf4 = opIdTracesOfB[1];
      expect(opIdTraceOf2).toEqual(["5@A", "2@B"]);
      expect(opIdTraceOf3).toEqual(["5@B", "3@B"]);
      expect(opIdTraceOf4).toEqual(["5@B", "3@A"]);

      b.apply([concurrentUndoA]);
      a.apply([concurrentUndoB]);
      // step (2b) in paper (after sync)
      expect([b.get(), a.get()]).toEqual([
        [3, 4, 2],
        [3, 4, 2],
      ]);

      a.apply([b.undo()]);
      // step (3) in paper
      expect([a.get(), b.get()]).toEqual([[2], [2]]);
      expect(a.undoStack().map((op) => op.opId)).toEqual([[1, "A"]]);
      expect(a.redoStack().map((op) => op.opId)).toEqual([[5, "A"]]);
      expect(b.undoStack().map((op) => op.opId)).toEqual([[2, "B"]]);
      expect(b.redoStack().map((op) => op.opId)).toEqual([
        [5, "B"],
        [6, "B"],
      ]);

      concurrentSetA = a.set(6);
      concurrentUndoB = b.undo()!;
      // not shown in paper; step (4) before sync
      expect([a.get(), b.get()]).toEqual([[6], [1]]);

      b.apply([concurrentSetA]);
      a.apply([concurrentUndoB]);
      // step (4) in paper
      expect([a.get(), b.get()]).toEqual([
        [1, 6],
        [1, 6],
      ]);
      expect(a.undoStack().map((op) => op.opId)).toEqual([
        [1, "A"],
        [7, "A"],
      ]);
      expect(a.redoStack().map((op) => op.opId)).toEqual([]);
      expect(b.undoStack().map((op) => op.opId)).toEqual([]);
      expect(b.redoStack().map((op) => op.opId)).toEqual([
        [5, "B"],
        [6, "B"],
        [7, "B"],
      ]);

      expect(a.redo()).toBeUndefined();

      a.apply([b.redo()]);
      // step (5) in paper
      expect([a.get(), b.get()]).toEqual([[2], [2]]);
      expect(a.undoStack().map((op) => op.opId)).toEqual([
        [1, "A"],
        [7, "A"],
      ]);
      expect(a.redoStack().map((op) => op.opId)).toEqual([]);
      expect(b.undoStack().map((op) => op.opId)).toEqual([[2, "B"]]);
      expect(b.redoStack().map((op) => op.opId)).toEqual([
        [5, "B"],
        [6, "B"],
      ]);

      a.apply([b.redo()]);
      // step (6) in paper
      expect([a.get(), b.get()]).toEqual([
        [3, 4, 2],
        [3, 4, 2],
      ]);
      expect(a.undoStack().map((op) => op.opId)).toEqual([
        [1, "A"],
        [7, "A"],
      ]);
      expect(a.redoStack().map((op) => op.opId)).toEqual([]);
      expect(b.undoStack().map((op) => op.opId)).toEqual([
        [2, "B"],
        [3, "B"],
      ]);
      expect(b.redoStack().map((op) => op.opId)).toEqual([[5, "B"]]);

      a.apply([b.redo()]);
      // step (7) in paper
      expect([a.get(), b.get()]).toEqual([[5], [5]]);
      expect(a.undoStack().map((op) => op.opId)).toEqual([
        [1, "A"],
        [7, "A"],
      ]);
      expect(a.redoStack().map((op) => op.opId)).toEqual([]);
      expect(b.undoStack().map((op) => op.opId)).toEqual([
        [2, "B"],
        [3, "B"],
        [4, "B"],
      ]);
      expect(b.redoStack()).toEqual([]);

      expect(b.redo()).toBeUndefined();
    });

    test("figure 4", () => {
      const a = Picomerge.create<number>("A");

      a.set(1);
      a.undo();
      a.redo();
      a.undo();
      a.redo();
      a.undo();
      const lastOp = a.redo();
      expect(lastOp?.opId).toEqual([7, "A"]);

      expect(a.get()).toEqual([1]);
      expect(
        a.terminalHeads().map(([_op, meta]) => meta.resolutionDepth),
      ).toEqual([4]);
    });

    test("figure 7: anti-counter argument", () => {
      const { left: a, right: b } = createLeftAndRight<string>("A", "B");

      // initial state
      b.apply([a.set(color.black)]);

      // user A's coloring to red
      b.apply([a.set(color.red)]);

      // user B's coloring to green
      a.apply([b.set(color.green)]);

      expect([a.get(), b.get()]).toEqual([[color.green], [color.green]]);

      // user A's undo
      b.apply([a.undo()]);

      // goes back to black
      expect([a.get(), b.get()]).toEqual([[color.black], [color.black]]);

      // user B's undo
      a.apply([b.undo()]);

      // goes back to red
      expect([a.get(), b.get()]).toEqual([[color.red], [color.red]]);
    });
  });
});
