# Main Runtime Preparation

The installed Mac runtime already contains earlier local-directory authority
work that was not committed. Reinstalling main without it would remove existing
revocation and Session path-identity protections. This integration isolates that
work on top of shared-group-history main `84e3b65`, excluding the shared source
checkout's unfinished workflow-mode/question changes and generated test outputs.

It retains local owner/source/tenant/inode consent fences, durable generations,
post-await and queue-drain revalidation, terminal Session error ordering and stop
access after revocation. These are execution-authority records, not a directory
picker catalogue or a requirement to pre-register paths. No production grant or
configuration is changed by this source integration. The Mac's explicit filesystem
selection policy remains separate from these optional authority records.

Hooks, consistency, full recursive build, isolated default recursive tests and
the no-tag release guard pass. The additional source-loader regression passes
75 tests without skips, covering local CLI protection, namespace ownership,
directory completion and Session create/send/recovery/insertion/compression,
including revoke/re-admit races. Its nested compatibility assertion also checks
31 existing tests; those are not another 31 top-level cases. An initial attempt
to run these source-oriented fixtures as plain compiled JS failed due to missing
TypeScript transformation/import hooks; the documented Node 24 source loader
passes without adding generated JavaScript to source directories.

Existing dependency bytes are reused through a small, owned link overlay; no
dependency installation or copied dependency tree is needed. Tests use isolated
temporary state and clean their owned resources. This record confirms source
verification, not deployment; runtime build/activation receipts must identify a
clean, pushed main commit after integration. Preserve all real data and credentials.
