// Cheetah dev-server lifecycle — this project's defaults over the binder's
// generic helper (cheetah/binders/nodejs/lib/server.js).
//
// The binder leaves the server's own configuration alone unless told
// otherwise, and builds into the submodule. Three things are ours, not
// Cheetah's, so they are bound here rather than upstream:
//
//   - the binary and data directory live at *this* repository's root, which is
//     where .gitignore, benchmark.sh and every existing run expect them;
//   - CHEETAH_GRAPH_TERM_INDEX=0, because the lexical term index cross-matches
//     hex node ids that share a word and costs a write on every node upsert
//     (ROADMAP §3.3);
//   - pair_bytes=2, the trie geometry our key layout was measured against.
//     It is adopted only when a database directory is created.

const path = require('path');
const binder = require('./binder');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_BINARY = path.join(REPO_ROOT, 'cheetah-server');
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, 'cheetah_data');
/** The submodule checkout — the Go module the binary is built from. */
const SUBMODULE_DIR = path.join(REPO_ROOT, 'cheetah');

function ensureServerBinary(options = {}) {
    return binder.server.ensureServerBinary({
        binaryPath: DEFAULT_BINARY,
        sourceDir: SUBMODULE_DIR,
        ...options,
    });
}

/** Start a headless cheetah-server with this project's defaults. */
async function startServer(options = {}) {
    return binder.server.startServer({
        port: 4467,
        cwd: REPO_ROOT,
        dataDir: DEFAULT_DATA_DIR,
        binaryPath: DEFAULT_BINARY,
        sourceDir: SUBMODULE_DIR,
        graphTermIndex: false,
        pairIndexBytes: 2,
        ...options,
    });
}

module.exports = {
    CheetahServerProcess: binder.server.CheetahServerProcess,
    DEFAULT_BINARY,
    DEFAULT_DATA_DIR,
    REPO_ROOT,
    SUBMODULE_DIR,
    ensureServerBinary,
    startServer,
    waitForListener: binder.server.waitForListener,
};
