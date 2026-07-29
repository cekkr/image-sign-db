// Value + name layer helpers — the two-step Cheetah write, in one place.
//
// Cheetah separates the bytes from the name: `INSERT` stores a payload and
// returns an absolute key, `PAIR_SET` binds a trie prefix to that key. There is
// no combined command, so a write is two round trips and a read is two
// (`PAIR_GET` then `READ`). Everything that persists a record goes through
// here so the pairing is never half-done in one caller and whole in another.
//
// Byte transparency: the socket speaks latin1, which maps bytes 1:1 to code
// units, so UTF-8 payloads must be transcoded on the way in and out. A JSON
// document with an accented filename is the common case.

const {
    buildCommand,
    parseCursor,
    parseItems,
    rawArgument,
} = require('./protocol');
const { CheetahError } = require('./client');

/** UTF-8 text → the latin1 spelling that puts those exact bytes on the wire. */
function toWire(text) {
    return Buffer.from(String(text), 'utf8').toString('latin1');
}

/** The inverse: latin1 wire text → the UTF-8 string it encodes. */
function fromWire(text) {
    return Buffer.from(String(text), 'latin1').toString('utf8');
}

function assertSingleLine(payload) {
    if (payload.includes('\n') || payload.includes('\r')) {
        throw new CheetahError('cheetah payloads must not contain a newline');
    }
    if (payload.length === 0) {
        throw new CheetahError('cheetah payloads must not be empty (INSERT answers missing_value)');
    }
    return payload;
}

/** Resolve a name to its absolute value key, or null when unbound. */
async function getAbsoluteKey(conn, key) {
    const response = await conn.command('PAIR_GET', key);
    if (response.ok) {
        const absKey = Number.parseInt(response.fields.key, 10);
        return Number.isFinite(absKey) ? absKey : null;
    }
    if (response.error && response.error.startsWith('not_found')) return null;
    throw new CheetahError(`cheetah PAIR_GET ${key} failed: ${response.error || response.raw}`, {
        response,
    });
}

/** Hydrate the bytes behind an absolute key. Returns null when deleted. */
async function readAbsoluteKey(conn, absKey) {
    const response = await conn.send(buildCommand('READ', absKey));
    if (response.ok) return fromWire(response.fields.value ?? '');
    if (response.error && response.error.startsWith('key_not_found')) return null;
    throw new CheetahError(`cheetah READ ${absKey} failed: ${response.error || response.raw}`, {
        response,
    });
}

/**
 * Bind `key` to `payload`.
 *
 * `upsert: false` (the default, and what ingestion wants) is the two-round-trip
 * blind write: INSERT then PAIR_SET. Rebinding a name this way leaves the old
 * value readable by its own absolute key — harmless for write-once rows like
 * `f:`, wasteful for records that are rewritten, which is what `upsert: true`
 * is for: it EDITs the existing value in place and keeps the key stable.
 */
async function putValue(conn, key, payload, { upsert = false } = {}) {
    const wire = assertSingleLine(toWire(payload));
    if (upsert) {
        const existing = await getAbsoluteKey(conn, key);
        if (existing !== null) {
            const edited = await conn.send(`EDIT ${existing} ${wire}`);
            if (!edited.ok) {
                throw new CheetahError(`cheetah EDIT ${existing} failed: ${edited.error || edited.raw}`, {
                    response: edited,
                });
            }
            return existing;
        }
    }
    const inserted = await conn.send(`INSERT ${wire}`);
    if (!inserted.ok) {
        throw new CheetahError(`cheetah INSERT failed: ${inserted.error || inserted.raw}`, {
            response: inserted,
        });
    }
    const absKey = Number.parseInt(inserted.fields.key, 10);
    if (!Number.isFinite(absKey)) {
        throw new CheetahError(`cheetah INSERT returned no key: ${inserted.raw}`, { response: inserted });
    }
    await conn.commandOrThrow('PAIR_SET', key, absKey);
    return absKey;
}

/** Read the payload bound to `key`, or null when the name is unbound. */
async function getValue(conn, key) {
    const absKey = await getAbsoluteKey(conn, key);
    if (absKey === null) return null;
    return readAbsoluteKey(conn, absKey);
}

async function putJson(conn, key, value, options) {
    return putValue(conn, key, JSON.stringify(value), options);
}

async function getJson(conn, key) {
    const raw = await getValue(conn, key);
    if (raw === null) return null;
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new CheetahError(`cheetah value at ${key} is not JSON: ${error.message}`);
    }
}

/**
 * One page of a `PAIR_SCAN` (or `PAIR_REDUCE`, with `reducer`).
 *
 * The cursor is handed back **verbatim** through `rawArgument`. Encoding it
 * would hex-encode the `x<hex>` token Cheetah returned, and the server would
 * resume from a prefix that does not exist — a sweep that quietly stops after
 * the first page instead of failing.
 */
async function scanPage(conn, prefix, { limit = 500, cursor = null, reducer = null, includeHidden = false } = {}) {
    const options = includeHidden ? 'include_hidden=1' : undefined;
    const cursorArg = cursor ? rawArgument(cursor) : undefined;
    const response = reducer
        ? await conn.command('PAIR_REDUCE', reducer, prefix, limit, cursorArg, options)
        : await conn.command('PAIR_SCAN', prefix, limit, cursorArg, options);
    if (!response.ok) {
        throw new CheetahError(`cheetah scan of ${prefix} failed: ${response.error || response.raw}`, {
            response,
        });
    }
    return {
        items: parseItems(response.fields.items),
        cursor: parseCursor(response.fields),
        response,
    };
}

/**
 * Every entry under `prefix`, one page at a time. `maxItems` bounds a sweep
 * that would otherwise be unbounded — `f:` holds thousands of rows per image.
 */
async function* scanPrefix(conn, prefix, { limit = 500, maxItems = Infinity, reducer = null, includeHidden = false } = {}) {
    let cursor = null;
    let yielded = 0;
    do {
        const page = await scanPage(conn, prefix, { limit, cursor, reducer, includeHidden });
        for (const item of page.items) {
            if (yielded >= maxItems) return;
            yielded += 1;
            yield item;
        }
        cursor = page.cursor;
    } while (cursor);
}

/** `scanPrefix` collected into an array. */
async function scanAll(conn, prefix, options) {
    const items = [];
    for await (const item of scanPrefix(conn, prefix, options)) items.push(item);
    return items;
}

module.exports = {
    fromWire,
    getAbsoluteKey,
    getJson,
    getValue,
    putJson,
    putValue,
    readAbsoluteKey,
    scanAll,
    scanPage,
    scanPrefix,
    toWire,
};
