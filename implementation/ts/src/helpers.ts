import { Op, Picomerge } from "./picomerge";

/**
 * Creates two Picomerge instances with the given actor IDs (for testing).
 */
export const createLeftAndRight = <V>(
  leftActorId = "left",
  rightActorId = "right",
) => {
  const left = Picomerge.create<V>(leftActorId);
  const right = Picomerge.create<V>(rightActorId);
  return { left, right };
};

/**
 * Creates a new Picomerge instance with the given actor ID,
 * sets an initial value and then applies `length` undo and redo operations.
 */
export const generateUndoRedoSequence = <V>(
  actorId: string,
  initValues: V[],
  length: number,
): [Picomerge<V>, Op<V>[]] => {
  const picomerge = Picomerge.create<V>(actorId);
  for (const initValue of initValues) picomerge.set(initValue);
  return [
    picomerge,
    Array.from({ length }, (_, i) => i).flatMap((_i) => [
      picomerge.undo()!,
      picomerge.redo()!,
    ]),
  ];
};

/**
 * Creates a new Picomerge instance with the given actor ID,
 * and then applies `length` set operations.
 */
export const generateSetSequence = (
  actorId: string,
  length: number,
): [Picomerge<number>, Op<number>[]] => {
  const picomerge = Picomerge.create<number>(actorId);
  return [
    picomerge,
    Array.from({ length }, (_, i) => i).map((i) => picomerge.set(i)),
  ];
};
