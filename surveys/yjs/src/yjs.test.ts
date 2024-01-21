import * as Y from "yjs";

type Replica = {
  origin: string;
  doc: Y.Doc;
  undoMngr: Y.UndoManager;
};

const createReplica = (
  origin: string,
  id: number,
  trackedOrigins?: Set<any>,
): Replica => {
  const doc = new Y.Doc();
  // fix the client id for having deterministic outcomes for concurrent
  // updates according to
  // https://github.com/yjs/docs/blob/main/api/faq.md#i-get-a-new-clientid-for-every-session-is-there-a-way-to-make-it-static-for-a-peer-accessing-the-document
  doc.clientID = id;
  const map = doc.getMap("map");
  return {
    origin,
    doc,
    undoMngr: new Y.UndoManager(map, {
      // a capture timeout of 0 prevents grouping multiple changes into
      // one undo item based on time, as we want to have manual tx scoping
      captureTimeout: 0,
      trackedOrigins,
    }),
  };
};

const sync = ({ doc: docA }: Replica, { doc: docB }: Replica) => {
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
};

const initValue = 0 as const;
const initRegister = (replica: Replica) => setRegister(replica, initValue);

const setRegister = ({ doc, origin }: Replica, value: unknown) => {
  doc.transact((tx) => {
    tx.doc.getMap("map").set("x", value);
  }, origin);
};

const getRegister = ({ doc }: Replica): number =>
  doc.getMap("map").get("x") as number;

const getRegisters = (a: Replica, b: Replica) => [
  getRegister(a),
  getRegister(b),
];

const printState = (a: Replica, b: Replica) => {
  const displayReplica = (replica: Replica) =>
    `${replica.origin} (${replica.doc.clientID}): ${getRegister(replica)}`;
  const s = `---\n${displayReplica(a)}\n${displayReplica(b)}`;
  console.log(s);
};

let replicaA: Replica;
let replicaB: Replica;

describe("LWW support only", () => {
  beforeEach(() => {
    replicaA = createReplica("A", 1);
    replicaB = createReplica("B", 2);
    initRegister(replicaA);
    sync(replicaA, replicaB);
  });

  test(`both replicas initialized to ${initValue}`, () => {
    expect(getRegisters(replicaA, replicaB)).toEqual([initValue, initValue]);
  });

  test("higher clientId wins for concurrent updates", () => {
    setRegister(replicaA, 1);
    setRegister(replicaB, 2);

    sync(replicaA, replicaB);

    expect(getRegisters(replicaA, replicaB)).toEqual([2, 2]);
    // no way to recover replicaA's update to `1`
  });
});

describe("default undo behavior with no filtered origins", () => {
  beforeEach(() => {
    replicaA = createReplica("A", 1);
    replicaB = createReplica("B", 2);
    initRegister(replicaA);
    sync(replicaA, replicaB);
  });

  test("is global undo behavior (no concurrency)", () => {
    setRegister(replicaA, 1);
    sync(replicaA, replicaB);
    setRegister(replicaB, 2);
    sync(replicaA, replicaB);

    // replicaA is undoing replicaB's change here
    replicaA.undoMngr.undo();
    sync(replicaA, replicaB);

    expect(getRegisters(replicaA, replicaB)).toEqual([1, 1]);
  });

  test("is global undo behavior (with concurrency)", () => {
    setRegister(replicaA, 1);
    setRegister(replicaB, 2);

    sync(replicaA, replicaB);
    expect(getRegisters(replicaA, replicaB)).toEqual([2, 2]);
    // replicaA is undoing replicaB's change here (the concurrency winner)
    replicaA.undoMngr.undo();
    expect(getRegisters(replicaA, replicaB)).toEqual([1, 2]);

    sync(replicaA, replicaB);
    expect(getRegisters(replicaA, replicaB)).toEqual([1, 1]);
  });
});

describe("undo behavior with filtered origins for trying to achieve local undo", () => {
  // yjs' API allows to specify `trackedOrigins`
  // https://github.com/yjs/docs/blob/main/api/undo-manager.md
  // we try to use them to only allow a replica's own changes to
  // to be undone, but this is not possible, as undo functionality
  // is blocked with remote changes (see below)

  beforeEach(() => {
    // each replica tracks only their own changes for undoing
    replicaA = createReplica("A", 1, new Set(["A"]));
    replicaB = createReplica("B", 2, new Set(["B"]));
    initRegister(replicaA);
    sync(replicaA, replicaB);
  });

  test("filtered origins prevent undo from untracked origins", () => {
    setRegister(replicaA, 1);
    sync(replicaA, replicaB);
    expect(replicaB.undoMngr.canUndo()).toEqual(false);
    expect(replicaA.undoMngr.canUndo()).toEqual(true);
  });

  test("no local undo behavior possible", () => {
    setRegister(replicaA, 1);
    sync(replicaA, replicaB);

    // here A can still both undo and redo (compare with below)
    replicaA.undoMngr.undo();
    expect(getRegister(replicaA)).toEqual(0);
    replicaA.undoMngr.redo();
    expect(getRegister(replicaA)).toEqual(1);
    sync(replicaA, replicaB);

    setRegister(replicaB, 2);
    sync(replicaA, replicaB);
    expect(getRegisters(replicaA, replicaB)).toEqual([2, 2]);

    // replicaA should not be undoing replicaB's change here, but instead
    // it's own last one, i.e., setting from 0 -> 1
    replicaA.undoMngr.undo();
    // interestingly A's ability to undo is blocked here...
    expect(getRegisters(replicaA, replicaB)).toEqual([2, 2]);
    // hence, local undo behavior is not possible as remote changes block
    // the ability to undo
    expect(replicaA.undoMngr.canUndo()).toEqual(false);

    // sync the failed undo attempt, should have no effect
    sync(replicaA, replicaB);
    expect(getRegisters(replicaA, replicaB)).toEqual([2, 2]);

    // B can still unde as it is the replica who owns
    // the current value of the LWW
    expect(replicaB.undoMngr.canUndo()).toEqual(true);
  });
});
