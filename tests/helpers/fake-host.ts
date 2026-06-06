// MOVED → ../tests-new/_support/fake-host.ts
// Thin re-export shim (D13/R11): the real module now lives under
// tests-new/_support/. This shim keeps still-green old-suite consumers that
// import this path resolving. Delete when the last old consumer is skipped.
export * from '../../tests-new/_support/fake-host.ts'
