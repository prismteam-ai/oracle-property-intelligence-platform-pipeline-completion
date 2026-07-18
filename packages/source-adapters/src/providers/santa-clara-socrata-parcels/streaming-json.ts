const DEFAULT_MAXIMUM_ITEM_CHARS = 16 * 1024 * 1024;
const MAXIMUM_ENVELOPE_CHARS = 256 * 1024;

function decodeError(error: unknown): Error {
  return new Error('Streaming JSON is not valid UTF-8', { cause: error });
}

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
    throw decodeError(error);
  }
}

/** Performs a bounded first pass so root envelope semantics can be verified before rows are emitted. */
export async function inspectGeoJsonEnvelope(
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Readonly<{ type: string; crs: string }>> {
  let prefix = '';
  let tail = '';
  for await (const text of decodedChunks(chunks, signal)) {
    if (prefix.length < MAXIMUM_ENVELOPE_CHARS) {
      prefix += text.slice(0, MAXIMUM_ENVELOPE_CHARS - prefix.length);
    }
    tail = (tail + text).slice(-MAXIMUM_ENVELOPE_CHARS);
  }
  const type = /"type"\s*:\s*"(FeatureCollection)"/u.exec(prefix)?.[1];
  const crs = /"crs"\s*:\s*\{[\s\S]*?"properties"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/u.exec(
    tail,
  )?.[1];
  if (type === undefined || crs === undefined) {
    throw new Error('GeoJSON root envelope omitted FeatureCollection type or named CRS');
  }
  return Object.freeze({ type, crs });
}

/** Yields one JSON object at a time from a named root array without retaining prior objects. */
export async function* streamJsonObjectArrayProperty(
  chunks: AsyncIterable<Uint8Array>,
  propertyName: string,
  signal: AbortSignal,
  maximumItemChars = DEFAULT_MAXIMUM_ITEM_CHARS,
): AsyncIterable<unknown> {
  if (!Number.isSafeInteger(maximumItemChars) || maximumItemChars < 1) {
    throw new RangeError('maximumItemChars must be a positive safe integer');
  }
  const marker = new RegExp(
    `"${propertyName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"\\s*:\\s*\\[`,
    'u',
  );
  let search = '';
  let foundArray = false;
  let item = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let closed = false;

  for await (const text of decodedChunks(chunks, signal)) {
    let offset = 0;
    if (!foundArray) {
      search += text;
      const match = marker.exec(search);
      if (match === null) {
        if (search.length > MAXIMUM_ENVELOPE_CHARS) {
          throw new Error(`JSON root did not expose bounded ${propertyName} array`);
        }
        continue;
      }
      foundArray = true;
      offset = match.index + match[0].length - (search.length - text.length);
      search = '';
      if (offset < 0) offset = 0;
    }

    for (let index = offset; index < text.length; index += 1) {
      signal.throwIfAborted();
      const character = text[index];
      if (character === undefined) continue;
      if (closed) {
        continue;
      }
      if (depth === 0) {
        if (/\s/u.test(character) || character === ',') continue;
        if (character === ']') {
          closed = true;
          continue;
        }
        if (character !== '{') throw new Error(`${propertyName} array contains a non-object value`);
        item = character;
        depth = 1;
        inString = false;
        escaped = false;
        continue;
      }

      item += character;
      if (item.length > maximumItemChars) {
        throw new Error(`JSON object exceeded ${maximumItemChars} characters`);
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
          throw new Error('Malformed JSON object in streamed array', { cause: error });
        }
        item = '';
        yield parsed;
      }
    }
  }
  if (!foundArray || !closed || depth !== 0) {
    throw new Error(`JSON ${propertyName} array ended before its closing bracket`);
  }
}
