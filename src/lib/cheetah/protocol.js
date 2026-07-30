// Cheetah wire-protocol codec — now owned by the submodule's Node binder
// (cheetah/binders/nodejs/lib/protocol.js), which is where its documentation
// and its tests live. This file exists so the require paths in this project
// keep pointing at one module name rather than at a path into the submodule.
//
// `assertKeySpaceIsOurs` is the binder's `assertUnreservedKey` under its
// original name; keys.js still calls it that.

module.exports = require('./binder').protocol;
