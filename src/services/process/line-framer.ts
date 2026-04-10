/**
 * Pure async generator: split on '\n', strip a single trailing '\r', yield
 * non-empty residual on EOF, complete silently on empty EOF.
 *
 * Accepts either AsyncIterable<Uint8Array> or ReadableStream<Uint8Array>.
 */
export function frameLines(
  _source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  throw new Error('not implemented')
}
