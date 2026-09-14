# Bundled Rescue evidence

Pack `2026.09.14.1` changes evidence packaging only, not the reviewed procedure source, applicability, permissions, or historical acceptance levels. It makes the consistency gate self-contained in a fresh checkout.

- Five JSON artifacts contain **exact selected lines** from historical reports, with original repository-relative path, full original SHA256 and inclusive line ranges. They retain relevant success, failure and scope limitations, not full raw acceptance evidence. These excerpts were checked byte-for-byte against the originals during import.
- The `*-patch.json` stores the **byte-identical** reviewed adapter implementation delta in its JSON `patch` string (including original whitespace). Its SHA256 remains `76e66934f439f072150dcef42ad59b51b5f92c0a2198178b5b9807ee8074ba87`. It identifies the implementation boundary, not a released npm version. It is provenance data; do not blindly apply it over current source.
- `rescue-knowledge-manifest.json` pins the public artifact hashes and retains original path/hash/kind. The generator verifies bundled bytes and provenance consistency, then verifies the generated registry. It never loads historical acceptance paths. No evidence check is replaced with an unconditional pass.
- Original report hashes are historical provenance: a fresh checkout can validate its bundled projections, **not independently reconstruct omitted originals or replay live/native acceptance**. Historical relative links inside exact quoted text identify withheld artifacts and are not build dependencies or promises of public availability.
- No wire/native logs, real configuration files, credential backups, keys, databases, virtualenvs or load-test artifacts are included. Model names, loopback endpoints and explicit test placeholders in excerpts/patches are non-secret historical fixture information, not deployment defaults or newly authorized configuration changes.
- Original private acceptance remains in the operator's local `acceptance/` tree. The import mapping and verification results are recorded locally in `acceptance/commit-20260914/`; that directory is not a build dependency and is not committed.

This packaging does not claim new live/model testing, production deployment, OpenClaw skill publication, or closure of D03/D08, B5/B6/C. A3's empty-method-list authorization contract is unchanged.
