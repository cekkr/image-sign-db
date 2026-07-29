# ROADMAP — MySQL → Cheetah DB Migration

Authoritative plan for replacing MySQL with [`cheetah`](cheetah) as Image Sign DB's storage and
retrieval engine, and for rebuilding recognition around **n-gram probe paths** and a **property
graph** that resolves a set of measured descriptors into an image ID.

**Status of this document:** Phases 0–2 are implemented and the Phase 2 exit gate has passed.
`STORAGE_BACKEND=cheetah` selects Cheetah for exhaustive ingestion and for the random first cycle of
progressive ingestion, preserves the incomplete→complete commit marker, and enforces a bounded
payload-byte storage budget after each committed ingest. Search, evaluation, guided ingestion,
correlation discovery, and graph-aware pruning remain on the planned side of the migration. An item
is `Planned` until it moves to `Shipped` in [`AGENTS.md`](AGENTS.md) with a verification note.

**Scope note:** this is a rewrite of the persistence and retrieval layer, not of the measurement
layer. [`src/lib/constellation.js`](src/lib/constellation.js),
[`src/lib/vectorGenerators.js`](src/lib/vectorGenerators.js),
[`src/lib/augmentations.js`](src/lib/augmentations.js), [`src/lib/gridStats.js`](src/lib/gridStats.js)
and [`src/lib/colorUtils.js`](src/lib/colorUtils.js) produce descriptors and values and are
**unchanged** by this migration. What changes is everything that speaks SQL.

---

## 1. Why Cheetah, and what actually maps

Verified against the checked-out submodule (`8ecdf35`) by booting the server and driving it over TCP.

| Image Sign DB need | MySQL today | Cheetah mechanism |
| --- | --- | --- |
| Descriptor hash → id | `value_types` + `UNIQUE(descriptor_hash)` | Pair trie: the key **is** the index. `PAIR_SET d:<hash> <abs_key>` |
| Feature row lookup by exact `(value_type, pos_x, pos_y)` | `idx_feature_lookup` B-tree | Byte-prefix walk: `PAIR_SCAN f:<tok>/<anchor>/…` |
| Tolerance match on `resolution_level`, `rel_x`, `rel_y` | `ABS(a-b) <= tol` full scan of the index slice | Bucketed key segments + a 2-bucket sweep (§3.2) |
| Candidate intersection across probes | `remaining.filter(id => …)` in Node | `GRAPH_RECALL` noisy-OR activation over descriptor seeds → ranked image IDs |
| `knowledge_nodes` GROUP (pattern) | self-referencing table + hit/miss ints | Graph edge `discriminates` with **first-class `confidence`/`modality`** |
| `feature_group_stats` | aggregate table + weighted-mean upsert | `PAIR_REDUCE` over a `stat:` namespace |
| "What should I ask next?" | `fetchRelatedConstellations` (hit-count sort) | **N-gram followers**: `PAIR_REDUCE counts g:<order>:<ctx>` |
| `feature_usage`, `skip_patterns`, `system_settings` | three small tables | Three pair namespaces |
| Storage budget pruning | `information_schema` size query + `DELETE` | `PAIR_SUMMARY` (shape without hydrating) + `DEL pairs prefix=` |

Three properties make this more than a swap:

1. **The trie removes the join.** Every MySQL candidate query is one index seek followed by a
   filtered scan. In Cheetah the filter *is* the key, so the same question is a prefix walk with no
   join, no `value_types` lookup, and no row hydration until a payload is actually wanted
   (`PAIR_SUMMARY` answers "how many are under here" without reading a byte).
2. **`confidence`/`modality` fix a live gap.** [`AGENTS.md`](AGENTS.md) records that
   `knowledge_nodes.miss_count` is never incremented, so every confidence is `1.0`. Cheetah edges
   carry a real belief scale (`ruled_out < unlikely < possible < probable < certain`) that persists
   across partial upserts, and `GRAPH_RECALL` ranks *with* it. The migration is the natural moment to
   start recording misses.
3. **The n-gram reducers already exist.** `PAIR_REDUCE counts/probabilities/backoffs/continuations`
   were built for exactly the payload shape a probe-path model needs
   ([`cheetah/CONCEPTS.md`](cheetah/CONCEPTS.md) documents the byte layouts).

### Verified behaviour (probe run, not folklore)

Booted `CHEETAH_HEADLESS=1 CHEETAH_LISTEN_ADDR=127.0.0.1:4467` and drove it from Node:

```text
>>> PAIR_SET fv:0001:5000:5000 1        <<< SUCCESS,pair_set
>>> PAIR_SCAN fv:0001: 10               <<< SUCCESS,count=2,items=<hex>:1;<hex>:1
>>> PAIR_SUMMARY fv: 2                  <<< SUCCESS,count=2,total_payload_bytes=42,…,branches=3030:2
>>> GRAPH_EDGE_SET from=desc:abc123 to=img:1 type=observed_in weight=0.9 confidence=0.8
>>> GRAPH_RECALL seeds=desc:abc123 hops=2
<<< SUCCESS,resolved=2,visited=3,count=1,…
    payload → {"associations":[{"id":"img:1","score":0.396,…}]}
```

The last line is the whole thesis: **descriptor seeds in, ranked image IDs out.**

---

## 2. Target architecture

```
featureExtractor / vectorGenerators   (unchanged — pixels → descriptor + value)
              │
              ▼
   src/lib/cheetah/client.js          (TCP, newline-delimited, one line in / one line out)
              │
    ┌─────────┴──────────┬─────────────────────┬────────────────────┐
    ▼                    ▼                     ▼                    ▼
 KV + pair trie      graph store           n-gram store        stats/admin
 d: descriptors      n<desc> nodes         g:<order>:<ctx>     stat: / use: / skip: / cfg:
 f: feature rows     m<image> nodes        → follower counts
 i: image records    observed_in edges     (PAIR_REDUCE counts)
                     discriminates edges
```

**Retrieval, end state:** the client measures probes; each measured descriptor becomes a
`GRAPH_RECALL` seed; activation converges on the image every probe agrees about; the n-gram store
picks the next probe from the path so far. Candidate intersection stops being an array filter in Node
and becomes ranked evidence with a score, a distance, and a `via` path the server can explain.

---

## 3. Key design (decide once — this is the wire format)

> **This section is the migration's single highest-risk decision.** Cheetah key bytes are the index;
> changing a key layout later means rebuilding the whole database, exactly as changing the descriptor
> object does today. Freeze §3 before writing ingestion code.

### 3.1 Namespaces

| Prefix | Key | Value (abs_key payload) | Replaces |
| --- | --- | --- | --- |
| `d:` | `d:<descriptorKey>` | descriptor JSON | `value_types` |
| `t:` | `t:<descriptorKey>` | uint32 token id | (new — n-gram vocabulary) |
| `r:` | `r:<tokenHex8>` | descriptorKey | reverse vocabulary |
| `f:` | `f:<tokenHex8>/<resB>/<axB>/<ayB>/<offXB>/<offYB>/<imageHex8>/<seqHex4>` | `{value, size, rel_x, rel_y}` | `feature_vectors` |
| `i:` | `i:<imageHex8>` | `{filename, created_at, complete}` | `images` |
| `fn:` | `fn:<filenameHash>` | imageHex8 | `images.original_filename` lookup |
| `use:` | `use:<featureKeyHash>` | `{count, last_used, last_score}` | `feature_usage` |
| `skip:` | `skip:<descriptorKey>` | `{count, last_used}` | `skip_patterns` |
| `stat:` | `stat:<tokenHex8>/<resB>` | aggregate stats JSON | `feature_group_stats` |
| `g:` | `g:<order>:<tokenHex8>…` | follower counts (binary) | (new — probe-path n-grams) |
| `cfg:` | `cfg:<key>` | setting value | `system_settings` |

Rules:

- **Fixed-width hex segments only.** `PAIR_SCAN` is byte-ordered, so variable-width numbers sort
  wrong (`10` < `9`). Every numeric segment is zero-padded hex of a declared width. Never
  `String(n)`.
- **`/` is the segment separator** and must not appear inside a segment. Hex guarantees that.
- **Never emit keys under Cheetah's reserved control-byte prefixes** `\x01gn: \x02ge: \x03go:
  \x04gi: \x05gt:` or `graph/idx/`. All our prefixes are printable ASCII, so this holds by
  construction — keep it that way.
- **No key may begin with `x`.** Cheetah decodes any positional argument with a leading `x` as hex
  (`cheetah/src/helpers.go` → `parseValue`), so an `x:`-prefixed key is unaddressable in its bare
  spelling. This is why the filename namespace above is `fn:` and not `x:`, and it is asserted by
  `keys.assertValidKey`. The client escapes such arguments as `x<HEX>` automatically, but relying on
  that would silently double the wire cost of the hottest namespace.

**Implemented in [`src/lib/cheetah/keys.js`](src/lib/cheetah/keys.js)** — that file, not this table,
is the authority now. Two layout decisions were made while writing it and are recorded here:

- The n-gram `<order>` is **two hex digits** (`g:03:…`), not a bare number, so orders stay
  byte-ordered against each other like every other segment.
- Feature keys carry a trailing `<seqHex4>` after `<imageHex8>` to disambiguate several rows of one
  image landing in the same bucket cell.

### 3.2 Turning tolerance into buckets (the load-bearing trick)

MySQL asks `ABS(fv.rel_x - ?) <= 1e-3`. A trie cannot express that. Encode each tolerance dimension
as a **quantized bucket whose width is ≥ 2× the tolerance**, then read the target bucket and its two
neighbours:

```
bucket(v, width) = floor(v / width)      // width = 2 × tolerance, at least
lookup(v)        = scan bucket(v-tol), bucket(v), bucket(v+tol)   // ≤ 2 distinct buckets in practice
```

> **Do the division in integers.** Implementing this in floating point made the sweep return *three*
> buckets for roughly half of all probes: `(v - tol) / width` evaluates to `224.99999999999997` where
> exact arithmetic gives `225`, and because the tolerance is an exact multiple of the 1e-6 rounding
> grid the descriptor builders already use, landing on a bucket boundary is the common case rather
> than the rare one. [`keys.js`](src/lib/cheetah/keys.js) quantizes every value to 1e-6 first and
> buckets integers, which makes the ≤2 guarantee exact. A property test asserts it over 10⁵ draws
> per dimension.

With `OFFSET_TOLERANCE = 1e-3` and `RESOLUTION_LEVEL_TOLERANCE = 1e-4` this gives:

| Dimension | Range | Tolerance | Bucket width | Segment |
| --- | --- | --- | --- | --- |
| `resolution_level` (span) | `[0.02, 0.45]` | `1e-4` | `2e-4` → 2150 buckets | `<resB>` = 4 hex |
| `anchor_u`, `anchor_v` | `[0, 1]` | exact match today | `1/ANCHOR_SCALE` | `<axB>`,`<ayB>` = 4 hex |
| `offset_x`, `offset_y` | `[-1.5, 1.5]` | `1e-3` | `2e-3` → 1500 buckets | `<offXB>`,`<offYB>` = 4 hex |

Because anchors are already an **exact-match** contract (see `AGENTS.md` → "pos_x/pos_y are exact-match
anchor buckets"), `<axB>`/`<ayB>` are a straight re-encoding of today's `pos_x`/`pos_y` and need no
sweep. Only the three genuinely-toleranced dimensions sweep, and a naive implementation would issue
3³ = 27 scans per probe.

**Do not do that.** Order the segments so the swept dimensions are *deepest*: put
`<tokenHex8>/<resB>/<axB>/<ayB>` first (token and anchors are exact, resolution sweeps ±1) and scan
the single prefix `f:<tok>/<resB>/<axB>/<ayB>/`, then filter `offset` in Node over the returned page.
The offsets only discriminate within one anchor cell of one descriptor — a handful of rows — so the
client-side filter is cheap and the scan count drops to **3** (one per resolution bucket).

> **Decision: keep offsets below the scan prefix.** A 50-image real-data ingest produced 15 000
> feature rows across 11 860 `f:<tok>/<resB>/<axB>/<ayB>/` pages: p50=1, p95=2, p99=3, max=5, and
> zero pages above 500. Client-side offset filtering therefore remains cheap for the measured random
> ingestion corpus; `<offXB>` is not promoted into the prefix. Re-measure on materially denser
> ingestion modes, but changing the layout now requires a key-layout version bump and re-ingest.

### 3.3 Graph shape

| Element | ID / type | Carries |
| --- | --- | --- |
| Descriptor node | `n<tokenHex8>` | labels `descriptor`, `ch_<channel>`, `aug_<augmentation>` |
| Image node | `m<imageHex8>` | labels `image`; props `{filename}` |
| `observed_in` | `n<tok>` → `m<img>` | `weight` = normalized usage; `props.v` = measured value bucket |
| `discriminates` | `n<tokA>` → `n<tokB>` | `weight` = separation score; `confidence`/`modality` = hit/miss belief |
| `co_occurs` | `n<tokA>` ↔ `n<tokB>` | undirected, `weight` = co-observation count |

**Node IDs must not share lexical tokens.** Verified in the probe run: seeding `desc:abc123` also
matched `desc:def456` at score `0.33` — Cheetah's `\x05gt:` term index tokenizes IDs, and the shared
word `desc` was enough. With SHA-1 hex IDs this would produce constant spurious recall. Two mitigations,
apply **both**:

- Use bare `n<hex>` / `m<hex>` IDs with **no separator word** — nothing to share.
- Run the migrated database with `CHEETAH_GRAPH_TERM_INDEX=0`. We seed recall by exact ID only; free-text
  seeding is meaningless for hex descriptors, and the index costs a write on every node upsert.

### 3.4 N-gram probe paths

A search is a sequence of probes. Treat each descriptor's token id as a word and the path as a
sentence, then use the reducers Cheetah already ships:

- Context key: `g:<order>:<tok1><tok2>…<tok(order-1)>` (fixed-width hex, no separators — the trie
  collapses shared prefixes automatically).
- Payload: the `encode_counts` layout from [`cheetah/CONCEPTS.md`](cheetah/CONCEPTS.md) — version
  byte, order byte, follower count, then `(token_id uint32, count)` big-endian pairs.
- Read: `PAIR_REDUCE counts g:<order>:<ctx>` returns followers inline, base64, **no follow-up
  `READ`** — one round trip per next-probe decision.
- Back off from order 4 → 3 → 2 → 1 when a context is unseen (stupid backoff is sufficient;
  `PAIR_REDUCE probabilities` exists if a proper Katz model is wanted later).

This replaces `buildNextQuestion`'s "highest hit_count neighbour, 80/20 random" policy with a model
that conditions on **the path so far**, not just the last probe — which is the actual reason the
current policy plateaus.

---

## 4. Cheetah-side work

Per the standing rule in [`AGENTS.md`](AGENTS.md), changes to [`cheetah/`](cheetah) are committed
directly on its `main`, `gofmt`-clean, with `go build ./... && go vet ./... && go test ./src` green,
and its own `AGENTS.md`/`NEXT_STEPS.md` updated in the same commit.

**Nothing has been changed in Cheetah yet.** These are candidates, in priority order, each to be
confirmed as necessary by measurement before being written:

1. **`PAIR_REDUCE vote <prefix>` — server-side candidate tally.** *(highest value)* Today the plan
   hydrates every feature row of a scan page to count which image IDs appear. A reducer that walks a
   namespace and returns `imageId → count` aggregated server-side turns per-probe candidate
   collection into one round trip with a tiny response. Register in
   [`cheetah/src/reducers.go`](cheetah/src/reducers.go) per their "reducers are registered, not
   hard-coded" contract — **not** a new `ExecuteCommand` branch.
2. **A bucket-range scan.** `PAIR_SCAN` takes one prefix. A `PAIR_SCAN_RANGE <lo> <hi>` (or a
   `range=` option) would collapse the 3-bucket resolution sweep into one call. Must reuse
   `pairScanAccumulator` and `selectPairBranch` — their trie contracts are explicit that hand-rolled
   walks lose keys on 2-byte databases.
3. **Recall consolidation write-back.** `GRAPH_RECALL` currently never writes back what it
   discovered — already an open item in their [`NEXT_STEPS.md`](cheetah/NEXT_STEPS.md). Our search
   loop wants exactly this: reinforce the edges that led to a correct identification. Coordinate with
   their roadmap rather than bolting on a private command.
4. **Per-database term-index opt-out.** `CHEETAH_GRAPH_TERM_INDEX` is process-wide; we want it off
   for the feature graph but it would be off for everything. A `DATABASE <name> term_index=0`
   override would fit their existing per-name override mechanism.

Use `pair_index_bytes = 2` for the feature database: their measurements show adaptive indexing is a
**no-op at stride 1** and only delivers the 99.4% storage / 99.7% enumeration win at stride 2. Set it
at creation (`RESET_DB <name> pair_bytes=2`) — `pairs/format.dat` is authoritative on reopen and a
later config change is silently ignored.

---

## 5. Migration phases

Each phase ends in a verifiable state. Do not start a phase before its predecessor's exit check passes.

### Phase 0 — Groundwork *(no behavior change)*

- [x] **0.1** Submodule added and pinned. ✅ *Done* — `cheetah` at `8ecdf35`. Build it from inside the
      submodule (`cd cheetah && go build -o ../cheetah-server ./src`) on Go 1.25.4; there is no
      `go.mod` at our repository root, so the root-relative spelling fails.
- [x] **0.2** [`src/lib/cheetah/client.js`](src/lib/cheetah/client.js) — TCP client. Newline-delimited,
      FIFO response matching (the protocol has no request IDs), bounded pipelining, reconnect with
      backoff, `DATABASE` priming on every reconnect, and a `CheetahPool` with `withConnection`
      leases for sequences that must not interleave.
- [x] **0.3** [`src/lib/cheetah/protocol.js`](src/lib/cheetah/protocol.js) — response parser and
      argument encoder. Pure functions, no socket.
- [x] **0.4** [`src/lib/cheetah/server.js`](src/lib/cheetah/server.js) — dev lifecycle helper: builds
      the binary if missing, spawns it headless on a configured port/data dir, polls for the
      listener, SIGTERM→SIGKILL shutdown.
- [x] **0.5** `settings.cheetah` in [`src/settings.js`](src/settings.js) + `settings.database.backend`
      (`STORAGE_BACKEND`), documented in [`README.md`](README.md) and [`TECH_NOTES.md`](TECH_NOTES.md).
- [x] **0.6** **First tests in this project's history.** `npm test` → `node --test test/*.test.js`,
      no new dependency. `npm run test:integration` adds the live round-trip.

Two files were added that §5 did not name, both because the alternative was duplicating a contract
across callers: [`kv.js`](src/lib/cheetah/kv.js) owns the two-step `INSERT`+`PAIR_SET` write, the
`PAIR_GET`+`READ` read, and cursor paging; [`vocabulary.js`](src/lib/cheetah/vocabulary.js) is
item 1.2.

**Exit check: ✅ passed.** `npm run test:integration` builds and spawns a server on an ephemeral port
and round-trips `PAIR_SET`/`PAIR_GET`/`PAIR_SCAN` (with paging)/`PAIR_SUMMARY`/`GRAPH_NODE_SET`/
`GRAPH_EDGE_SET`/`GRAPH_RECALL`/`DEL pairs`; `npm test` is green at 34 tests.

Three defects the live round-trip caught that the unit tests could not:

1. A `next_cursor` fed back through the ordinary argument encoder is hex-encoded a second time — the
   server resumes from a prefix that does not exist and the sweep **silently returns one page**
   instead of failing. Fixed with `protocol.rawArgument` and a `kv.scanPrefix` helper so no caller
   hand-rolls a cursor loop.
2. `TokenVocabulary.descriptorFor` returned the token instead of the descriptor hash.
3. Float bucketing widened the resolution sweep to 3 buckets — see the note in §3.2.

### Phase 1 — Key codec

- [x] **1.1** [`src/lib/cheetah/keys.js`](src/lib/cheetah/keys.js) — the single owner of §3.
      **No other file may concatenate a Cheetah key.**
- [x] **1.2** Token vocabulary ([`vocabulary.js`](src/lib/cheetah/vocabulary.js)): a uint32 per
      descriptor, persisted `t:`/`r:`, counter at `cfg:next_token` guarded by a single-flight promise
      chain, plus a per-descriptor in-flight map so concurrent first sights of the same hash collapse
      to one allocation. **This is process-local.** Cheetah has no compare-and-swap, so two
      *processes* ingesting into one database would race; today's pipeline has a single parent
      process and the note is in the file.
- [x] **1.3** Property tests ([`test/cheetah-keys.test.js`](test/cheetah-keys.test.js)).

**Exit check: ✅ passed.** 20 000 random feature keys sort identically by `Buffer.compare` (what
`PAIR_SCAN` actually does) and by their numeric tuple; negative offsets sort below positive ones;
10⁵ random descriptors produce >99 000 distinct hashes and >99 000 distinct feature keys with no
encoding collisions; 10⁵ draws per toleranced dimension confirm the sweep never misses a row within
tolerance and never exceeds 2 buckets.

### Phase 2 — Backend-selected ingestion

- [x] **2.1** `src/lib/cheetah/store.js` — the storage interface the rest of the code will call:
      `ensureDescriptor`, `putFeatures`, `putImage`, `markComplete`, `findCandidates`, `recordUsage`,
      `saveSkip`, `getSetting`/`setSetting`. ✅ *Done* — the store also validates
      `cfg:key_layout_version`, uses random collision-checked uint32 image IDs so worker processes do
      not share another counter, and hydrates candidate scan payloads with `PAIR_REDUCE
      continuations`.
- [x] **2.2** Teach [`src/featureExtractor.js`](src/featureExtractor.js) to write through
      `STORAGE_BACKEND`. Keep the MySQL path byte-identical; add the Cheetah path beside it.
      **Batch aggressively** — one `PAIR_SET` per feature row is a round trip per row; use the
      pipelined queue and consider a `JOB`-wrapped batch. ✅ *Done* — exhaustive ingestion and the
      progressive random cycle route through the Cheetah store in bounded pipelined batches.
      Knowledge-guided cycles are explicitly skipped until their statistics move in Phase 4.
- [x] **2.3** Preserve the `ingestion_complete` contract: write `i:<img>` with `complete:false`, all
      features, then rewrite `complete:true`. Every Cheetah reader filters on it. ✅ *Done* — covered
      by the live store test, which proves an image is absent before `markComplete` and visible after.
- [x] **2.4** Storage budget: reimplement `ensureStorageCapacity` on `PAIR_SUMMARY`
      (`total_payload_bytes` without hydrating) + exact `DEL pairs key=` deletes. ✅ *Done* —
      `CheetahStore` totals every owned namespace without hydrating payloads, ranks complete-image
      feature rows by usage count/last-use time, and deletes at most 5 000 cold rows per pass plus
      their usage records. Incomplete images are protected. The cap is explicitly a payload-byte
      budget, not a physical disk quota; graph-pinned feature protection must be added with Phase 4.

**Verification:** `npm run test:integration` passes 46 tests against an OS-assigned
non-default port. A direct `src/train.js` smoke test against port 4469 ingested three generated
images with six features each while an explicit `--threads=4` was safely constrained to one;
`PAIR_SUMMARY f:` returned 18 and all three `i:` records read `complete:true`.

**Exit check: ✅ passed.** A real 50-image dataset was ingested under
`STORAGE_BACKEND=cheetah` against port 4471 with an explicit `--threads=8` safely constrained to one.
All 50 image records read `complete:true`; the run wrote 15 000 feature rows in 209.279 seconds.
Owned payload accounting reported 3 854 640 bytes across 50 683 records, while the Cheetah data
directory occupied 30 482 677 bytes. The gap is expected: `PAIR_SUMMARY.total_payload_bytes`
excludes trie/table overhead, so it is a deterministic retention signal rather than filesystem
usage. The measured scan-page distribution is recorded in §3.2.

### Phase 3 — Read path

- [ ] **3.1** `findCandidates(probe)` on the trie: bucket the probe, scan the ≤3 resolution buckets,
      filter offsets client-side, group by image. Must reproduce
      [`collectElasticMatches`](src/lib/elasticMatcher.js) semantics **including its documented
      nearest-entry fallback** — that behavior is load-bearing and its absence would change every
      reported result.
- [ ] **3.2** Port [`src/evaluate.js`](src/evaluate.js) `evaluateFilterRun` to the new store. This is
      the natural first read-path cutover because the evaluation harness is the closest thing the
      project has to a regression check.
- [ ] **3.3** **Parity gate:** run `--evaluate` against MySQL and Cheetah on the same dataset with the
      same seeds and compare match sets. Differences must be explained, not averaged away.

**Exit check:** identical top-1 image on ≥95% of evaluation runs across backends; every divergence
attributed to a named cause.

### Phase 4 — Graph layer

- [ ] **4.1** On ingest, upsert `n<tok>` descriptor nodes and `observed_in` edges to `m<img>`.
- [ ] **4.2** Port `discoverCorrelations` ([`src/lib/knowledge.js`](src/lib/knowledge.js)) to write
      `discriminates` edges with `weight` = separation score and `confidence` = the hit/miss ratio.
      **Record misses this time** — the whole belief scale is worthless if only hits are written, and
      that is precisely the bug the current MySQL implementation has.
- [ ] **4.3** Replace candidate intersection with `GRAPH_RECALL seeds=<measured tokens>
      min_sources=2`. `min_sources=2` is the convergence view — nodes that *several* probes agree on,
      which is exactly "the image all my measurements point at".
- [ ] **4.4** Replace `GRAPH_SIMILAR` for the "which images are confusable with this one" step of
      correlation discovery.
- [ ] **4.5** Feed search outcomes back: reinforce edges on a correct identification, and record a
      miss on a wrong one (see Cheetah task §4.3).

**Exit check:** a `GRAPH_RECALL`-driven search matches or beats the trie-intersection search on the
evaluation harness, and `miss_count`-equivalent belief is demonstrably below `certain` on at least
some edges.

### Phase 5 — N-gram path model

- [ ] **5.1** Record every completed search path as an n-gram observation (orders 1–4) under `g:`.
- [ ] **5.2** Replace `buildNextQuestion` with follower lookup + stupid backoff (§3.4).
- [ ] **5.3** Keep an exploration floor — a purely greedy model stops discovering new patterns, which
      is why the current implementation injects random probes at all.
- [ ] **5.4** Compare average probe count to identification against the Phase 4 baseline. **This is
      the number the whole migration is for.**

**Exit check:** measurably fewer probes to a correct ID than Phase 4, on the same dataset.

### Phase 6 — MySQL removal

- [ ] **6.1** Delete the SQL paths from `featureExtractor`, `insert`, `evaluate`, `index`, `train`,
      `knowledge`, `storageManager`, `realTimePruner`, `schema`.
- [ ] **6.2** Delete [`src/setupDatabase.js`](src/setupDatabase.js) and
      [`src/testCorrelations.js`](src/testCorrelations.js); replace with a Cheetah bootstrap script.
- [ ] **6.3** Drop `mysql2` from [`package.json`](package.json). Add nothing in its place — the client
      is `net`.
- [ ] **6.4** Retire [`src/vectorCustom.js`](src/vectorCustom.js) (already dead — see
      [`AGENTS.md`](AGENTS.md)).
- [ ] **6.5** Rewrite [`README.md`](README.md) and [`TECH_NOTES.md`](TECH_NOTES.md) around Cheetah;
      update [`scripts/check-maintenance.js`](scripts/check-maintenance.js) triggers for the new file
      set.

**Exit check:** `grep -rn "mysql2\|information_schema\|INSERT INTO" src/` is empty; a full
train → evaluate → search cycle runs against Cheetah alone.

---

## 6. Risks

| Risk | Why it bites | Mitigation |
| --- | --- | --- |
| **Key layout wrong** | Cheetah keys are the index; a change means a full rebuild, exactly like a descriptor-shape change today | Frozen at layout version 1 after Phase 1 property tests and the Phase 2 real-data page measurement; re-measure dense modes before any version bump |
| **Round-trip amplification** | One `PAIR_SET` per feature row × ~2400 rows/image × N images | Pipeline on one socket; batch; measure ingest throughput at Phase 2 exit before scaling up |
| **No transactions** | MySQL gave atomic-ish multi-row writes; Cheetah does not | Keep the `complete` flag protocol (§2.3) as the only consistency contract — it already is, today |
| **Spurious lexical recall** | Verified: hex IDs sharing a token word cross-match at 0.33 | Bare `n<hex>`/`m<hex>` IDs **and** `CHEETAH_GRAPH_TERM_INDEX=0` (§3.3) |
| **Trie prefix-overlap defects** | Cheetah's own handbook flags jump collapse/split as high regression risk, worst at stride 2 — which is the stride we want | Exercise their `TestJumpTerminalOverlaps`-style cycles on our key shapes; report defects upstream with a failing test |
| **Silent parity drift** | Two backends, no tests today | Phase 3.3 parity gate is a hard gate, not a smoke test |
| **Migration of existing data** | Legacy integer `resolution_level` rows are already unmatchable (see `AGENTS.md`) | **Do not migrate.** Re-ingest from source images; there is no meaningful conversion |
| **Cheetah is a moving target** | Its `main` is pulled every session and we may commit to it | Submodule pins a SHA; bump deliberately, never silently, and note the SHA when behavior depends on it |

---

## 7. Open questions

1. **One database or several?** Features, graph, and n-grams could share one Cheetah database or be
   split (different strides suit different shapes — the graph is sparse, `f:` is wide). Splitting
   costs cross-database coordination in the client.
2. **Do descriptor values belong in the key?** Quantizing `value` into the key would make the elastic
   distance search a prefix walk too — but it hard-codes the threshold into the layout, and the
   elastic matcher's whole point is a *relaxing* threshold. Probably no. Decide before Phase 3.
3. **Is `PREDICT_*` a better fit than `g:` n-grams?** Cheetah ships prediction tables with context
   matrices. They may subsume the hand-rolled n-gram store — or be overkill. Evaluate at Phase 5.
4. **Sequencing** — should the n-gram path model (Phase 5) land before the graph layer (Phase 4)?
   Phase 5 is cheaper and independently measurable; Phase 4 is the bigger architectural win. Current
   order favours the win; reversing is defensible.
