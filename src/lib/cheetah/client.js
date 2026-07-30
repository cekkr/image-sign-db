// Cheetah TCP client — owned by the submodule's Node binder
// (cheetah/binders/nodejs/lib/client.js). `CheetahClient`, `CheetahPool`,
// `CheetahError`, `CheetahConnectionError`, `CLIENT_DEFAULTS`.
//
// The contracts that matter to callers here are unchanged: the protocol has no
// request ids, so responses match commands by arrival order on a connection,
// and a multi-command sequence that must not interleave needs
// `pool.withConnection` rather than `pool.send`.

module.exports = require('./binder').client;
