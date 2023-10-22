/**
 * Partitions an iterable into two arrays based on a predicate.
 */
export const partition = <T>(
  iterable: Iterable<T>,
  pred: (t: T) => boolean,
): [T[], T[]] => {
  const valid: T[] = [],
    invalid: T[] = [];
  for (const item of iterable) {
    if (pred(item)) {
      valid.push(item);
    } else {
      invalid.push(item);
    }
  }
  return [valid, invalid];
};

/**
 * Zips two arrays together for their shared length, i.e., the minimum
 * of the two lengths.
 */
export const zip = <T, U>(a: T[], b: U[]): [T, U][] =>
  Array.from(Array(Math.min(a.length, b.length)), (_, i) => [a[i], b[i]]);
