/**
 * Pure async generator: split on '\n', strip a single trailing '\r', yield
 * non-empty residual on EOF, complete silently on empty EOF.
 *
 * Accepts either AsyncIterable<Uint8Array> or ReadableStream<Uint8Array>.
 */
export async function* frameLines(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let buffer = ''

  const iterable = toAsyncIterable(source)

  for await (const chunk of iterable) {
    buffer += decoder.decode(chunk, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      yield stripCR(part)
    }
  }

  // Flush any trailing decoder state
  buffer += decoder.decode()

  if (buffer.length > 0) {
    yield stripCR(buffer)
  }
}

function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function toAsyncIterable(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    return source as AsyncIterable<Uint8Array>
  }
  return readableStreamToAsyncIterable(source as ReadableStream<Uint8Array>)
}

async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}
