import { partition, zip } from "./utils";

/**
 * A unique identifier of an actor.
 */
type ActorId = string;
/**
 * ctr@actorId, where the ctr is a timestamp obtained from a Lamport clock
 * and together with the actorId they form a Lamport timestamp ("Lampstamp").
 */
type OpId = [number, ActorId];
type StringifiedOpId = string; // via OpId.toString(opId) ctr@actorId

/**
 * A multi-value register (MVR) is a register that can hold multiple values
 * in case of non-linear histories, i.e., concurrent updates.
 */
type MvRegister<V> = {
  /**
   * If the register has not been initialized, the values will be an empty array.
   * Otherwise, values will be a decreasingly sorted array of values
   * according to the total order induced by the OpId.
   * The values are also called siblings.
   */
  values: V[];
  /**
   * This is only used for unit testing.
   */
  terminalHeads: [TerminalOp<V>, ResolutionMetadata][];
};

/**
 * The opIdTrace is a list of opIds that is generated while resolving a head
 * of kind `restore`.
 */
type OpIdTrace = StringifiedOpId[];
const OpIdTrace = {
  compare: (a: OpIdTrace, b: OpIdTrace): -1 | 0 | 1 => {
    for (const [aOpId, bOpId] of zip(a, b)) {
      const comparison = OpId.compare(
        OpId.fromString(aOpId),
        OpId.fromString(bOpId),
      );
      if (comparison !== 0) return comparison;
    }
    // For the caching optimiztion to work we have to return equality here
    // because the cached `OpIdTraces` are pruned up to their respective `RestoreOp`
    // and deeper entries are truncated.
    // Yet, this works because the cached values corresponding to the `RestoreOp` are
    // already sorted correctly.
    return 0;
    // Technically, the following behavior is correct if we were to compare non-pruned
    // `OpIdTraces` at all times.
    // By construction of the `OpIdTraces` any two valid `OpIdTraces` differ before
    // hitting their last zipped elements.
    // throw new Error(
    //   "Impossible: Each path from a head to a terminal op must be unique",
    // );
  },
};

/**
 * The resolution depth is the number of times an op of kind `restore` has been
 * encountered while resolving a head.
 */
type ResolutionDepth = number;
/**
 * This metadata is collected while resolving a head of the operation history.
 */
type ResolutionMetadata = {
  opIdTrace: OpIdTrace;
  resolutionDepth: ResolutionDepth;
};

type OpKind = (typeof OpKind)[keyof typeof OpKind];
const OpKind = {
  set: 0,
  restore: 1,
} as const;

/**
 * An operation is either a `set` operation or a `restore` operation.
 */
export type Op<V> = SetOp<V> | RestoreOp;
/**
 * Terminal operations are operations that produce a value and do not search
 * the operation history for the values they might produce.
 * Currently only `set` operations are terminal operations but a `delete` operation
 * may be modeled as a distinct operation kind (instead of using `set` with `undefined`,
 * how it is done here).
 * If that alternative approach is chosen, the `delete` operation would also
 * be a terminal operation.
 */
export type TerminalOp<V> = SetOp<V>;

/**
 * Shared by all operations.
 */
type OpBase = {
  opId: OpId;
  /**
   * Preds is empty iff it is a peer's initial operation on the register.
   */
  preds: Set<StringifiedOpId>;
};

/**
 * The operation of kind `set` is used for both setting a value in the register
 * and deleting value(s) from the register.
 */
type SetOp<V> = OpBase & {
  kind: typeof OpKind.set;
  value?: V;
};

/**
 * The operation of kind `restore` is used to enable both undo and redo functionality.
 * In general, it restores to the state immediately before the referenced operation
 * in the `anchor` field.
 */
type RestoreOp = OpBase & {
  kind: typeof OpKind.restore;
  anchor: OpId;
};

/**
 * This cache can be used to store the resolved values for a `RestoreOp`
 * to trade space for computation time.
 * It stores the sorted values produced by the `RestoreOp` identified
 * by the key of the map.
 */
type Cache<V> = Map<StringifiedOpId, TerminalOp<V>[]>;

export const OpId = {
  create: (ctr: number, actorId: ActorId): OpId => [ctr, actorId],
  actor: (opId: OpId): ActorId => opId[1],
  ctr: (opId: OpId): number => opId[0],
  toString: (opId: OpId): string => `${opId[0]}@${opId[1]}`,
  fromString: (str: string): OpId => {
    const [ctr, actorId] = str.split("@");
    return [parseInt(ctr, 10), actorId];
  },
  compare: (a: OpId, b: OpId): -1 | 0 | 1 => {
    const [aCtr, aActorId] = a;
    const [bCtr, bActorId] = b;
    const ctrDiff = aCtr - bCtr;
    if (ctrDiff === 0) {
      if (aActorId === bActorId) return 0;
      else return aActorId < bActorId ? -1 : 1;
    }
    return ctrDiff < 0 ? -1 : 1;
  },
};

type Clock = ReturnType<typeof Clock.create>;
const Clock = {
  create: (actorId: ActorId) => {
    let ctr = 0;

    const tick = () => OpId.create(ctr + 1, actorId);
    const sync = (remoteCtr: number) => {
      ctr = Math.max(ctr, remoteCtr);
    };
    const isGreater = (opId: OpId) => OpId.compare(opId, [ctr, actorId]) > 0;
    const current = () => ctr;

    return {
      /**
       * Does _not_ advance the clock but produces the next tick,
       * rendering this method side-effect free.
       */
      tick,
      /**
       * Advances the internal clock to the maximum of the current clock
       * and the remote clock.
       */
      sync,
      current,
      isGreater,
    };
  },
};

type History<V> = ReturnType<typeof History.create<V>>;
const History = {
  create: <V>(
    actorId: string,
    clock: Clock,
    useCache = false,
    logger?: (s: string) => void,
  ) => {
    // operations that are not yet causally ready wait in the lobby, that is,
    // all unapplied and causally not-yet-ready operations wait until their
    // causal dependencies (transitive predecessors) are applied
    let lobby: Map<StringifiedOpId, Op<V>> = new Map();
    // all _applied_ operations are stored here
    const appliedOps: Map<StringifiedOpId, Op<V>> = new Map();
    // for pred generation for new ops, we keep the current set of known heads
    const heads: Set<StringifiedOpId> = new Set();
    // for quick lookup of the (global) last op,
    // useful for reverting the last operation from _any_ actor
    let lastOp: Op<V> | null = null;
    const cache: Cache<V> = new Map();

    // local changes of the actor for undo/redo
    const undoStack: SetOp<V>[] = [];
    const redoStack: RestoreOp[] = [];

    // generates a shallow copy of the current heads
    const currentPreds = () => new Set(heads);

    const isLocalOp = (op: Op<V>) => isActorsOp(op, actorId);
    const _isRemoteOp = (op: Op<V>) => !isLocalOp(op);
    const isActorsOp = (op: Op<V>, actorId: ActorId) =>
      OpId.actor(op.opId) === actorId;

    const isRedoOp = (op: Op<V>, anchorOp?: Op<V>): op is RestoreOp =>
      op.kind === OpKind.restore &&
      (anchorOp ?? appliedOps.get(OpId.toString(op.anchor)))?.kind ===
        OpKind.restore;
    const isUndoOp = (op: Op<V>, anchorOp?: Op<V>): op is RestoreOp =>
      op.kind === OpKind.restore &&
      (anchorOp ?? appliedOps.get(OpId.toString(op.anchor)))?.kind !==
        OpKind.restore;
    const isTerminalOp = (op: Op<V>): op is TerminalOp<V> =>
      op.kind !== OpKind.restore;
    const isSetOp = (op: Op<V>): op is SetOp<V> =>
      op.kind === OpKind.set && op.value !== undefined;
    const isDeleteOp = (op: Op<V>): op is SetOp<V> =>
      op.kind === OpKind.set && op.value === undefined;

    const resolveToTerminalOp = (op: RestoreOp): TerminalOp<V> => {
      // takes at most two iterations to resolve to a terminal op
      do {
        const anchorOp = appliedOps.get(OpId.toString(op.anchor));
        if (!anchorOp) throw new Error("cannot resolve to terminal op");
        if (anchorOp.kind !== OpKind.restore) return anchorOp;
        op = anchorOp;
        // eslint-disable-next-line no-constant-condition
      } while (true);
    };

    const isCausallyReady = (op: Op<V>) =>
      Array.from(op.preds).every((pred) => appliedOps.has(pred));

    const processCausallyReady = (register: MvRegister<V>) => {
      const [ready, notReady] = partition(lobby.values(), isCausallyReady);
      lobby = new Map(notReady.map((op) => [OpId.toString(op.opId), op]));
      ready.forEach((op) => add(op, register, true));
    };

    const add = (
      op: Op<V>,
      register: MvRegister<V>,
      skipCausallyReadyCheck = false,
    ) => {
      const { opId } = op;
      const stringifiedOpId = OpId.toString(opId);

      // ignore already applied ops
      if (appliedOps.has(stringifiedOpId)) return;

      // delay ops which are not yet causally ready and put them into the lobby
      if (!skipCausallyReadyCheck && !isCausallyReady(op)) {
        if (!lobby.has(stringifiedOpId)) lobby.set(stringifiedOpId, op);
        return;
      }

      const anchorOp =
        op.kind === OpKind.restore
          ? appliedOps.get(OpId.toString(op.anchor))
          : undefined;
      const isRedo = isRedoOp(op, anchorOp);
      const isUndo = isUndoOp(op, anchorOp);
      const _isTerminal = isTerminalOp(op);
      const isSet = isSetOp(op);
      const isDelete = isDeleteOp(op);

      if (logger) {
        const opKind = isRedo
          ? `redo (restore op)`
          : isUndo
          ? `undo (restore op)`
          : isSet
          ? `set (set op)`
          : `delete (set op)`;

        const preds = `[${[...op.preds].join(", ")}]`;

        const payload = isSet
          ? ` and value '${JSON.stringify(op.value)}'`
          : isDelete
          ? ``
          : ` and anchor '${OpId.toString(op.anchor)}'`;

        logger(
          `Processing ${stringifiedOpId} ${opKind} with preds ${preds}${payload}`,
        );
      }

      // for the following we can assume that:
      // 1. all preds have already been applied, that is, the operation is causally ready
      // 2. but the effect of the op itself has not yet been applied

      const _advanceHeads = (() => {
        const preds = [...op.preds.values()];
        preds.forEach((pred) => heads.delete(pred));
        heads.add(stringifiedOpId);
      })();
      const _updateLastOp = (() => {
        if (!lastOp) lastOp = op;
        else if (OpId.compare(opId, lastOp.opId) > 0) lastOp = op;
      })();

      // this fn ensures that the terminal heads are:
      // 1. either a only set ops (generated either from a set() or delete())
      // 2. sorted by their opIdTrace
      const terminalHeads = (() => {
        const resolveToTerminalOp = (
          head: Op<V>,
          queue: [StringifiedOpId, ResolutionMetadata][],
        ): [TerminalOp<V>, ResolutionMetadata][] => {
          const result: [TerminalOp<V>, ResolutionMetadata][] = [];
          while (queue.length > 0) {
            const [nextOpId, metadata] = queue.shift()!;

            const newMetadata: ResolutionMetadata = {
              opIdTrace: [...metadata.opIdTrace, nextOpId],
              resolutionDepth: metadata.resolutionDepth + 1,
            };

            // in case the op is not yet known it must be the op that is
            // currently processed
            const nextOp = appliedOps.get(nextOpId) ?? op;
            switch (nextOp.kind) {
              case OpKind.set:
                result.push([nextOp, newMetadata]);
                continue;
              // restore ops are special in that they are not immediately producing
              // terminal heads, but instead they are pushing their predecessors
              // onto the queue
              case OpKind.restore: {
                const _restoreActor = OpId.actor(opId);
                const anchorOpIdStringified = OpId.toString(nextOp.anchor);
                const anchorOp = appliedOps.get(anchorOpIdStringified);
                if (!anchorOp)
                  throw new Error(
                    "Impossible: Anchor operation not found in applied ops, causally ready invariant violated",
                  );
                const toResolve = (() => {
                  if (!useCache) return [...anchorOp.preds];
                  const [cached, toResolve] = partition(
                    anchorOp.preds,
                    (pred) => (cache.get(pred) ? true : false),
                  );
                  cached.forEach((cachedPred) => {
                    const hit = cache.get(cachedPred)!;
                    result.push(
                      ...hit.map(
                        // the cached, _sorted_ order should be preserved as JS built-in sorting is stable
                        (v) =>
                          [
                            v,
                            {
                              opIdTrace: [...newMetadata.opIdTrace, cachedPred],
                              resolutionDepth: newMetadata.resolutionDepth + 1,
                            },
                          ] as [TerminalOp<V>, ResolutionMetadata],
                      ),
                    );
                  });
                  return toResolve;
                })();
                queue.push(
                  ...toResolve.map(
                    (pred) =>
                      [pred, newMetadata] as [
                        StringifiedOpId,
                        ResolutionMetadata,
                      ],
                  ),
                );
                continue;
              }
            }
          }
          if (useCache && head.kind === OpKind.restore) {
            cache.set(
              OpId.toString(head.opId),
              result
                .sort(
                  (
                    [_aOp, { opIdTrace: aOpIdTrace }],
                    [_bOp, { opIdTrace: bOpIdTrace }],
                  ) => OpIdTrace.compare(bOpIdTrace, aOpIdTrace),
                )
                .map(([op, _meta]) => op),
            );
          }
          return result;
        };

        const terminalHeads = [...heads]
          // 1. resolve the heads to terminal ops
          .flatMap((head) => {
            // in case the op is not yet known it must be the op
            // that is currently processed
            const headOp = appliedOps.get(head) ?? op;
            return resolveToTerminalOp(headOp, [
              [head, { opIdTrace: [], resolutionDepth: 0 }],
            ] as [StringifiedOpId, ResolutionMetadata][]);
          })
          // 2. sort the terminal ops by their op id trace
          .sort(
            (
              [_aOp, { opIdTrace: aOpIdTrace }],
              [_bOp, { opIdTrace: bOpIdTrace }],
            ) => OpIdTrace.compare(bOpIdTrace, aOpIdTrace),
          );

        return terminalHeads;
      })();

      // apply the effect of the current heads
      register.values = terminalHeads.reduce((acc: V[], [head, _metadata]) => {
        // only set ops with a value produce a value
        if (head.value !== undefined) acc.push(head.value);
        return acc;
      }, []);

      // just for testing purposes
      register.terminalHeads = terminalHeads;

      // after applying the op we put it into the applied ops set
      appliedOps.set(stringifiedOpId, op);
      // after applying the op we advance the clock
      clock.sync(OpId.ctr(opId));
      // after applying the op, other ops might be causally ready
      processCausallyReady(register);
    };

    const set = (value?: V): SetOp<V> => {
      const op: SetOp<V> = {
        opId: clock.tick(),
        kind: OpKind.set,
        preds: currentPreds(),
        value,
      };
      // we push the op to the undo stack, to allow it to be undone later
      undoStack.push(op);
      // if we have a new local terminal op, we clear the redo stack,
      // losing the ability to redo (as most mainstream software does it)
      redoStack.length = 0;
      return op;
    };

    const undo = (): RestoreOp | undefined => {
      if (undoStack.length === 0) return;
      const anchor = undoStack.pop()!;
      const op: RestoreOp = {
        opId: clock.tick(),
        kind: OpKind.restore,
        preds: currentPreds(),
        anchor: anchor.opId,
      };
      // we push the op to the redo stack, to allow it to be redone later
      redoStack.push(op);
      return op;
    };

    const redo = (): RestoreOp | undefined => {
      if (redoStack.length === 0) return;
      const anchor = redoStack.pop()!;
      const op: RestoreOp = {
        opId: clock.tick(),
        kind: OpKind.restore,
        preds: currentPreds(),
        anchor: anchor.opId,
      };
      const terminalOp = resolveToTerminalOp(op);
      // we push the terminal op to the undo stack, to allow it to be undone later
      // for another time
      undoStack.push(terminalOp);
      return op;
    };

    return {
      add: (op: Op<V>, register: MvRegister<V>) => add(op, register, false),
      set,
      undo,
      redo,
      undoStack: () => [...undoStack],
      redoStack: () => [...redoStack],
    };
  },
};

export type Picomerge<V> = ReturnType<typeof Picomerge.create<V>>;
export const Picomerge = {
  create: <V>(actorId: string, useCache = false) => {
    // the maximum operation counter seen so far expressed in a clock
    const clock = Clock.create(actorId);

    const _logger = (string: string) => {
      console.log(`[Actor '${actorId}'] ${string}`);
    };

    // the history of operations of the register
    const history = History.create<V>(actorId, clock, useCache);
    // the register with its current values
    const register: MvRegister<V> = { values: [], terminalHeads: [] };

    const apply = (ops: (Op<V> | undefined)[]) =>
      ops.forEach((op) => {
        if (op === undefined) return;
        history.add(op, register);
      });

    const get = (): V[] => register.values;

    const terminalHeads = (): [TerminalOp<V>, ResolutionMetadata][] =>
      register.terminalHeads;

    const set = (value: V): SetOp<V> => {
      const setOp = history.set(value);
      apply([setOp]);
      return setOp;
    };

    const delete_ = (): SetOp<V> | undefined => {
      // safeguard to protect from generating a delete operation locally
      // when the register is already empty.
      if (register.values.length === 0) return;
      const deleteOp = history.set();
      apply([deleteOp]);
      return deleteOp;
    };

    const undo = (): RestoreOp | undefined => {
      const undoOp = history.undo();
      apply([undoOp]);
      return undoOp;
    };

    const redo = (): RestoreOp | undefined => {
      const redoOp = history.redo();
      apply([redoOp]);
      return redoOp;
    };

    return {
      apply,
      get,
      set,
      delete: delete_,
      undo,
      redo,
      terminalHeads,
      undoStack: () => history.undoStack(),
      redoStack: () => history.redoStack(),
    };
  },
};
