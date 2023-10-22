import fs from "fs";
import { generateSetSequence, generateUndoRedoSequence } from "./helpers";
import { Picomerge } from "./picomerge";

type BenchmarkSuite<T extends string = string> = {
  name: string;
  beforeAll?: () => void;
  afterAll?: () => void;
  beforeEach?: () => void;
  afterEach?: () => void;
  benchmarks: Record<T, () => void>;
  transformer?: (measurement: number) => number;
  options?: {
    iterations?: number;
  };
};

type BenchmarkResults<T extends string = string> = {
  name: string;
  benchmarks: Record<T, BenchmarkResult>;
};

type BenchmarkResult = {
  measurements: number[];
  iterations: number;
  mean: number;
  min: number;
  firstQuartile: number;
  median: number;
  thirdQuartile: number;
  max: number;
  variance: number;
};

const runBenchmarkSuite = <T extends string>(
  suite: BenchmarkSuite<T>,
): BenchmarkResults<T> => {
  const {
    name,
    beforeAll,
    afterAll,
    beforeEach,
    afterEach,
    benchmarks,
    options,
  } = suite;
  const iterations = options?.iterations ?? 1024;

  console.log(`Running benchmark suite: ${name}`);
  if (beforeAll) beforeAll();
  const results = Object.fromEntries(
    Object.entries(benchmarks).map(([name, benchmarkFn]): [T, unknown] => {
      let measurements: number[] = [];
      for (let i = 0; i < iterations; i++) {
        if (beforeEach) beforeEach();
        const start = performance.now();
        // with a generic T parameter, the type of benchmarkFn is unknown somehow..
        (benchmarkFn as () => void)();
        const end = performance.now();
        const duration = end - start;
        measurements.push(duration);
        if (afterEach) afterEach();
      }
      if (suite.transformer) measurements = measurements.map(suite.transformer);
      measurements.sort((a, b) => a - b);
      const min = measurements[0];
      const firstQuartile = measurements[Math.floor(measurements.length / 4)];
      const median = measurements[Math.floor(measurements.length / 2)];
      const thirdQuartile =
        measurements[Math.floor((measurements.length / 4) * 3)];
      const max = measurements[measurements.length - 1];
      const mean =
        measurements.reduce((acc, curr) => acc + curr, 0) / measurements.length;
      const result: BenchmarkResult = {
        measurements,
        iterations: measurements.length,
        mean,
        min,
        firstQuartile,
        median,
        thirdQuartile,
        max,
        variance:
          measurements.reduce((acc, curr) => acc + (curr - mean) ** 2, 0) /
          measurements.length,
      };
      return [name, result] as [T, BenchmarkResult];
    }),
  ) as Record<T, BenchmarkResult>;
  if (afterAll) afterAll();

  return {
    name,
    benchmarks: results,
  };
};

let instance: Picomerge<number>;

let lengths = [200, 400, 600, 800];

const altUndoRedoSeqUndoResults = lengths.map((length) => {
  const undo: BenchmarkSuite = {
    name: `one undo after an undo/redo sequence of length ${length}`,
    beforeEach: () => {
      instance = generateUndoRedoSequence("A", [1, 2], length - 1)[0];
    },
    benchmarks: {
      ["undo"]: () => {
        instance.undo();
      },
    },
  };
  return [length, undo] as const;
});

const altUndoRedoSeqRedoResults = lengths.map((length) => {
  const redo: BenchmarkSuite = {
    name: `one redo after an undo/redo sequence of length ${length}`,
    beforeEach: () => {
      instance = generateUndoRedoSequence("A", [1, 2], length - 1)[0];
      instance.undo();
    },
    benchmarks: {
      ["redo"]: () => {
        instance.redo();
      },
    },
  };
  return [length, redo] as const;
});

lengths = new Array(50).fill(null).map((_, i) => i + 1);

const undoRedoSeqUndoResults = lengths.map((length) => {
  const undo: BenchmarkSuite = {
    name: `one undo after a sequence of length ${length}`,
    beforeEach: () => {
      instance = generateSetSequence("A", length)[0];
      let i = length - 1;
      while (i > 0) {
        instance.undo();
        i--;
      }
    },
    benchmarks: {
      ["undo"]: () => {
        instance.undo();
      },
    },
  };
  return [length, undo] as const;
});

const undoRedoSeqRedoResults = lengths.map((length) => {
  const redo: BenchmarkSuite = {
    name: `one redo after a sequence of length ${length}`,
    beforeEach: () => {
      instance = generateSetSequence("A", length)[0];
      // eslint-disable-next-line
      while (instance.undo()) {}
      let i = length - 1;
      while (i > 0) {
        instance.redo();
        i--;
      }
    },
    benchmarks: {
      ["redo"]: () => {
        instance.redo();
      },
    },
  };
  return [length, redo] as const;
});

const extractMeanFromBench = (name: string, results: BenchmarkResults) => {
  const benchmark = results.benchmarks[name];
  if (!benchmark) throw new Error(`Benchmark ${name} not found`);
  return benchmark.mean;
};

const toDataPoint = ([x, y]: [number, number]) => {
  return `(${x}, ${y})`;
};

const extractRelevant = (
  [x, results]: readonly [number, BenchmarkResults],
  name: string,
) => {
  return toDataPoint([x, extractMeanFromBench(name, results)]);
};

const driveBenchmark = (
  scenario: string,
  name: string,
  results: (readonly [number, BenchmarkSuite])[],
) => {
  const string = results
    .map(([length, suite]) => {
      const results = runBenchmarkSuite(suite);
      return extractRelevant([length, results], name);
    })
    .join("\n");
  fs.mkdirSync("./benchmark", { recursive: true });
  fs.writeFileSync(`./benchmark/${scenario}.txt`, string);
};

driveBenchmark("undoRedoSeqUndo", "undo", undoRedoSeqUndoResults);
driveBenchmark("undoRedoSeqRedo", "redo", undoRedoSeqRedoResults);
driveBenchmark("altUndoRedoSeqUndo", "undo", altUndoRedoSeqUndoResults);
driveBenchmark("altUndoRedoSeqRedo", "redo", altUndoRedoSeqRedoResults);
