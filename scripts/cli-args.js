/**
 * Shared CLI-arg helper for every scripts/*.js's hand-rolled `parseArgs`.
 *
 * Each parseArgs loop reads a flag's value with the pre-increment idiom
 * `argv[++i]`, which silently returns `undefined` when the flag is the last
 * argv element (e.g. a trailing `--slug` with nothing after it) — that
 * `undefined` then flows into `path.resolve()`/`Number()`/opts.* with no
 * complaint until something far downstream breaks confusingly. `nextArg`
 * wraps that read with a clear, immediate error naming the offending flag.
 *
 * Usage: replace `argv[++i]` with `nextArg(argv, ++i, '--flag-name')` — the
 * `++i` still advances the shared loop index exactly once, evaluating to the
 * value's position before `nextArg` reads `argv[i]` from it.
 */
export function nextArg(argv, i, flagName) {
  const value = argv[i];
  if (value === undefined) throw new Error(`${flagName} requires a value`);
  return value;
}
