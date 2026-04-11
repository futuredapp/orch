export type { CheckFn } from './check.ts'
export { check } from './check.ts'
export { DuplicateValidatorError, defineValidator, getValidator } from './define-validator.ts'
export { fileProduced } from './file-produced.ts'
export { gitCommitCreated } from './git-commit-created.ts'
export { gitDiffCreated } from './git-diff-created.ts'
export { ANONYMOUS_CHECK_NAME, anyNeedsHeadSha, normalizeValidators } from './normalize.ts'
export type {
  PersistedValidation,
  ValidationFailure,
  ValidationOutcome,
  Validator,
  ValidatorCtx,
  ValidatorResult,
  ValidatorServices,
} from './validator.ts'
export { fail, ok, ValidationError } from './validator.ts'
