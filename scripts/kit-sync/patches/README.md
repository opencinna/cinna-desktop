# Pending Core source updates

`local-schedules.patch` updates Core's kit schema descriptions, changelog, and
schedule guide for Desktop's schedule editor, script execution, and single
catch-up behavior. It changes guidance only; contract version 1.5.0 and validation
rules remain unchanged. The guide is part of Core's full kit, while the schema
and changelog also ship in Desktop's contract bundle.

The patch was applied to an isolated copy of the Core working tree whose baseline
render exactly matched Desktop's previous bundle (kit `489ce0983d531c3c`, Core
commit `9384c8883a1536b9eb2697bac6afa316a6377e1a` with uncommitted kit changes).
The sibling Core checkout was left unchanged. The existing supported sync command
then generated the new bundle and lock; no bundled file or tree hash was edited
by hand. As before, `core_dirty: true` records that the lock's commit alone is not
a complete source snapshot.

To apply upstream, run `git apply --check <desktop>/scripts/kit-sync/patches/local-schedules.patch`
in the matching Core source checkout, then `git apply` with the same path. Review
and merge those source edits in Core before dropping this pending patch.

To regenerate Desktop after applying the patch, run from Desktop:

```sh
node --experimental-strip-types scripts/kit-sync/sync.mjs --core /path/to/core-source
npm test -- src/main/kit/contractBundle.test.ts src/main/kit/conformance.test.ts
```

Use an isolated Core copy if the user's working checkout should remain untouched.
Copy its `docs/local_agent_kit/`, `backend/app/services/cli/local_agent_kit_service.py`,
and `backend/app/core/config.py` together, retaining the Git source identity.
Before applying the patch, confirm that a baseline sync matches the existing
bundle; do not silently import unrelated Core changes. After applying, changes
should be limited to the guidance plus content-derived kit versions and lock hash.
