# Windows managed interaction corrections

The installed Windows validation app reproduced two failures: the question tool
returned a cancelled answer immediately without displaying a dialog, and Stop
returned the composer to ready while a shell descendant continued writing.

The pinned rpiv question package uses a terminal-only custom component. Managed
staging now patches only version 1.20.0 with the expected upstream source hash.
In RPC mode it uses Pi's supported select and input requests, preserving preview,
multiple-question, multiple-choice, free-text, cancellation and answer shapes.
The terminal custom component is unchanged. Staging records compatibility hashes
and packaged verification checks them without modifying the bundle.

Managed Windows shell tools use Pi's public tool factories and operations seam.
The bundled Python helper starts each shell suspended, assigns it to a Windows
Job Object, and resumes it. Cancellation and timeout terminate the job and wait
for its active process count to reach zero before acknowledging cancellation.
The helper also holds a handle to the owning agent to detect agent exit without
PID reuse. Normal shell completion releases the job without terminating deliberate
background work. Other platforms and unmanaged terminals retain their existing
shell implementations. Pi continues to own streaming, output truncation, tool
rendering, timeout arguments and session metadata.

Source checks cover the question bridge and strict package compatibility. Run
the native shell regression after staging a real Windows managed runtime:

```powershell
node scripts/verify-windows-shell-tools.mjs <absolute-managed-runtime> <existing-disposable-evidence-directory>
```

This loads the actual Coop extension through bundled Pi and executes Bash and
PowerShell commands in a fresh Unicode directory with spaces and an ampersand.
It checks completion, cancellation and timeout with reparented descendants and
retains a receipt. It uses a disposable home, no model credentials and no client
data. The managed Windows CI job runs it too.

Native shell and RPC protocol evidence does not establish installed GUI Stop or
approval acceptance. Those workflows require a freshly packaged installation
and real user-interface verification; agent-exit handling also needs a dedicated
native regression before being counted as verified.
