// Value + name layer helpers — owned by the submodule's Node binder
// (cheetah/binders/nodejs/lib/kv.js).
//
// The two-step write (INSERT then PAIR_SET), its `upsert` variant, the batched
// form, the cursor-paged scans, and the latin1 ↔ UTF-8 transcoding.

module.exports = require('./binder').kv;
