// Preloaded into each suite the tap runner spawns (stryker/lane.mjs), after
// Stryker's own hook: process.exit waits until stdout has written what it
// holds.
//
// With --test-force-exit, node:test ends a suite with process.exit() once its
// reporter has handed its last chunk to stdout, not once stdout has written
// it. Where stdout is a pipe the reader is slow to empty, as Stryker's is on
// Linux, the tail of the TAP stream is lost: tap-parser reads the cut stream
// as a failure with no failing test, so a dry run is refused and a mutant run
// counts as Killed (nodejs/node#67149, seen on niyam#644 and #645). Node's
// fix, nodejs/node#67160, does the same wait in core: drop this file once
// .nvmrc names a Node release that carries it.
'use strict';

const exit = process.exit.bind(process);
let leaving = false;

// The arguments are passed on as given: Node's exit sets process.exitCode
// whenever it is given one, undefined included.
process.exit = function drainThenExit(...args) {
  // A second call, or one made while stdout cannot be written, ends at once.
  if (leaving || process.stdout.destroyed || process.stdout.writableLength === 0) return exit(...args);
  leaving = true;
  if (args.length > 0) process.exitCode = args[0];
  // Writes are ordered, so this callback runs once every earlier chunk has
  // been written, or has failed (a closed pipe, say).
  process.stdout.write('', () => exit());
  // Unlike exit, this returns. node:test calls it last, and the handles a
  // test left open keep the loop alive until the callback ends the process.
  return undefined;
};
