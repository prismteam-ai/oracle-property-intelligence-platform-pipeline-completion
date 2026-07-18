const DEFAULT_MAXIMUM_ITEM_CHARS = 16 * 1024 * 1024;

async function* decodedChunks(
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      const text = decoder.decode(chunk, { stream: true });
      if (text.length > 0) yield text;
    }
    const final = decoder.decode();
    if (final.length > 0) yield final;
  } catch (error: unknown) {
    if (signal.aborted) throw signal.reason;
    throw new Error('Streaming JSON is not valid UTF-8', { cause: error });
  }
}

/** Yields top-level array objects while retaining at most one bounded object. */
export async function* streamTopLevelJsonObjects(
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  maximumItemChars = DEFAULT_MAXIMUM_ITEM_CHARS,
): AsyncIterable<unknown> {
  if (!Number.isSafeInteger(maximumItemChars) || maximumItemChars < 1) {
    throw new RangeError('maximumItemChars must be a positive safe integer');
  }
  let opened = false;
  let closed = false;
  let item = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for await (const text of decodedChunks(chunks, signal)) {
    for (const character of text) {
      signal.throwIfAborted();
      if (!opened) {
        if (/\s/u.test(character)) continue;
        if (character !== '[') throw new Error('Socrata page must be a top-level JSON array');
        opened = true;
        continue;
      }
      if (closed) {
        if (!/\s/u.test(character)) throw new Error('Unexpected data after Socrata JSON array');
        continue;
      }
      if (depth === 0) {
        if (/\s/u.test(character) || character === ',') continue;
        if (character === ']') {
          closed = true;
          continue;
        }
        if (character !== '{') throw new Error('Socrata page contains a non-object row');
        item = character;
        depth = 1;
        continue;
      }
      item += character;
      if (item.length > maximumItemChars) {
        throw new Error(`Socrata row exceeded ${maximumItemChars} characters`);
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth -= 1;
      if (depth === 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(item) as unknown;
        } catch (error: unknown) {
          throw new Error('Malformed JSON object in Socrata page', { cause: error });
        }
        item = '';
        yield parsed;
      }
    }
  }
  if (!opened || !closed || depth !== 0) throw new Error('Socrata JSON array is incomplete');
}
