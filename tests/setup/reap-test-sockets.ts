// MOVED → ../../tests-new/_support/setup/reap-test-sockets.ts
// Thin re-export shim (D13/R11): the reaper now lives under tests-new/_support/
// (parent U13 setup-move). This shim keeps still-green old-suite consumers —
// notably the `cleanup-stale-tmux.ts` preload, which imports `./reap-test-sockets.ts`
// — resolving. Delete when the last old consumer is gone.
export * from '../../tests-new/_support/setup/reap-test-sockets.ts'
