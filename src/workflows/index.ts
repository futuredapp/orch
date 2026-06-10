// Public barrel for the built-in (`orch::`) workflows module.
//
// The CLI imports the locator from here; it never reaches into internal files.
// Dependency direction is CLI → workflows → core/runners; core never imports
// this module.

export { BUILTIN_NAMES } from './registry.ts'
export { BUILTIN_PREFIX, importBuiltin, isBuiltinName, resolveBuiltin } from './resolve-builtin.ts'
