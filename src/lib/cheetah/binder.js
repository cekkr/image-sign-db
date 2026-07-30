// The one place this project reaches into the Cheetah submodule for code.
//
// `cheetah/binders/nodejs` is Cheetah's own Node binder: the protocol codec,
// the pooled TCP client, the KV/graph helpers and `CheetahDatabase`, the base
// class our stores extend. It is not vendored here — it lives in the submodule
// and moves with the server it speaks to, which is the point. A protocol
// description kept in two repositories diverges in silence.
//
// Everything in `src/lib/cheetah/` is now one of two things: a re-export of a
// generic binder module (so existing require paths keep working), or a subclass
// that adds what only this project knows — its key layout, its namespaces, its
// completion protocol.

const path = require('path');

const BINDER_PATH = path.resolve(__dirname, '..', '..', '..', 'cheetah', 'binders', 'nodejs');

let binder;
try {
    binder = require(BINDER_PATH);
} catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
        throw new Error(
            `the Cheetah Node binder is missing at ${BINDER_PATH}. The submodule is probably not ` +
            'checked out — run: git submodule update --init\n' +
            `(underlying error: ${error.message})`
        );
    }
    throw error;
}

module.exports = binder;
module.exports.BINDER_PATH = BINDER_PATH;
