// Re-export of stripAnsi for harness consumers.
//
// Tests assert on visible-pane text, not raw bytes, so the default capture
// path strips ANSI before returning. captureRaw() (in pane-handle.ts) keeps
// the bytes for the narrow cases that need to assert escape sequences.

export { stripAnsi } from '../../../src/observability/index.ts'
