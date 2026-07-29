// Cheetah dev-server lifecycle helper — ROADMAP Phase 0.4.
//
// Spawns the vendored Go binary headless on a configured port and data dir,
// waits for the listener to accept, and shuts it down cleanly. This is a
// development and test convenience — production runs the server itself.
//
// Build the binary from the submodule (its go.mod lives there, not at our root):
//
//   cd cheetah && go build -o ../cheetah-server ./src

const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_BINARY = path.join(REPO_ROOT, 'cheetah-server');
const SUBMODULE_DIR = path.join(REPO_ROOT, 'cheetah');

function binaryExists(binaryPath) {
    try {
        return fs.statSync(binaryPath).isFile();
    } catch {
        return false;
    }
}

/**
 * Build `cheetah-server` from the submodule if it is missing (or `force`).
 * Returns the binary path. Throws with the compiler output on failure.
 */
function ensureServerBinary({ binaryPath = DEFAULT_BINARY, force = false } = {}) {
    if (!force && binaryExists(binaryPath)) return binaryPath;
    if (!fs.existsSync(path.join(SUBMODULE_DIR, 'go.mod'))) {
        throw new Error(
            `cheetah submodule is not checked out at ${SUBMODULE_DIR} — run: git submodule update --init`
        );
    }
    const result = spawnSync('go', ['build', '-o', binaryPath, './src'], {
        cwd: SUBMODULE_DIR,
        encoding: 'utf8',
    });
    if (result.error) {
        throw new Error(`cannot build cheetah-server: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`cheetah-server build failed:\n${result.stderr || result.stdout}`);
    }
    return binaryPath;
}

function tryConnect(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const done = (ok) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/** Poll until the listener accepts, or throw after `timeoutMs`. */
async function waitForListener(host, port, { timeoutMs = 10000, intervalMs = 50 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await tryConnect(host, port, Math.min(500, intervalMs * 4))) return true;
        if (Date.now() > deadline) {
            throw new Error(`cheetah-server did not start listening on ${host}:${port} within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

class CheetahServerProcess {
    constructor({ child, host, port, dataDir, logs }) {
        this.child = child;
        this.host = host;
        this.port = port;
        this.dataDir = dataDir;
        this.logs = logs;
        this.stopped = false;
    }

    /** SIGTERM, then SIGKILL if it does not exit in `graceMs`. */
    async stop({ graceMs = 3000 } = {}) {
        if (this.stopped || !this.child || this.child.exitCode !== null) {
            this.stopped = true;
            return;
        }
        this.stopped = true;
        await new Promise((resolve) => {
            const kill = setTimeout(() => {
                try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
            }, graceMs);
            this.child.once('exit', () => {
                clearTimeout(kill);
                resolve();
            });
            try { this.child.kill('SIGTERM'); } catch { clearTimeout(kill); resolve(); }
        });
    }
}

/**
 * Start a headless cheetah-server.
 *
 * `graphTermIndex: false` (the default here) sets CHEETAH_GRAPH_TERM_INDEX=0 —
 * ROADMAP §3.3 requires it, because the lexical term index cross-matches hex
 * node ids that share a word and costs a write on every node upsert.
 */
async function startServer(options = {}) {
    const {
        host = '127.0.0.1',
        port = 4467,
        dataDir = path.join(REPO_ROOT, 'cheetah_data'),
        binaryPath = DEFAULT_BINARY,
        build = true,
        graphTermIndex = false,
        pairIndexBytes = 2,
        env = {},
        captureLogs = true,
        readyTimeoutMs = 10000,
    } = options;

    const resolvedBinary = build ? ensureServerBinary({ binaryPath }) : binaryPath;
    if (!binaryExists(resolvedBinary)) {
        throw new Error(`cheetah-server binary not found at ${resolvedBinary}`);
    }
    fs.mkdirSync(dataDir, { recursive: true });

    const child = spawn(resolvedBinary, [], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            CHEETAH_HEADLESS: '1',
            CHEETAH_LISTEN_ADDR: `${host}:${port}`,
            CHEETAH_DATA_DIR: dataDir,
            CHEETAH_GRAPH_TERM_INDEX: graphTermIndex ? '1' : '0',
            CHEETAH_PAIR_INDEX_BYTES: String(pairIndexBytes),
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const logs = [];
    if (captureLogs) {
        const record = (stream) => (chunk) => {
            for (const line of String(chunk).split('\n')) {
                if (line.trim()) logs.push(`[${stream}] ${line}`);
            }
        };
        child.stdout.on('data', record('out'));
        child.stderr.on('data', record('err'));
    } else {
        child.stdout.resume();
        child.stderr.resume();
    }

    let exitedEarly = null;
    child.once('exit', (code, signal) => {
        exitedEarly = { code, signal };
    });

    const server = new CheetahServerProcess({ child, host, port, dataDir, logs });
    try {
        await waitForListener(host, port, { timeoutMs: readyTimeoutMs });
    } catch (error) {
        await server.stop();
        const detail = exitedEarly
            ? ` (process exited code=${exitedEarly.code} signal=${exitedEarly.signal})`
            : '';
        throw new Error(`${error.message}${detail}\n${logs.slice(-20).join('\n')}`);
    }
    return server;
}

module.exports = {
    CheetahServerProcess,
    DEFAULT_BINARY,
    REPO_ROOT,
    ensureServerBinary,
    startServer,
    waitForListener,
};
