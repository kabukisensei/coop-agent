# Windows update owner identity

Pending Windows replacement journals previously recorded only the helper PID.
After process exit and PID reuse, recovery could mistake an unrelated process for
the original helper and refuse to restore the previous application.

New journals use schema version 2 and persist both PID and OS process creation
time. Recovery queries that process through a fixed native PowerShell script
using a held process handle. It returns only PID and UTC creation ticks; it does
not enumerate other processes, read their command lines or inspect credentials.
An absent process or a different creation time means the original owner has
exited. A matching live external owner blocks recovery. The exact current helper
can still recover its own failed transaction.

Inspection errors preserve the transaction. Pending schema-1 journals cannot
prove creation identity and require recovery inspection; they are never silently
assigned to the current holder of that PID. Completed legacy journals retain
their existing directory-identity checks and remain readable.

`tests/windows-update-process.test.mjs` checks the strict response contract and,
on native Windows, observes one real process before and after confirmed exit.
`tests/windows-update-replacement.test.mjs` covers same-PID/different-creation
recovery, matching live ownership, unavailable inspection, and legacy pending
journals alongside actual helper death, cancellation, rename-gap recovery and
Windows directory locks. Both source runners include the process test.

These checks establish replacement ownership behavior. They do not establish a
complete Windows updater, independent recovery service, reboot journey, native
GUI update or installed rollback; those remain separate acceptance requirements.
