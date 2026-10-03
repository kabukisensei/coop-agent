# Teams mobile access (`/mobile`)

Approve guardrail prompts and steer a running coop session from your phone, in the
Teams app, in the chat with yourself. Master plan row M1 (section 12.3). Internal
use; off by default; one setup per tenant and one sign-in per machine.

## What it does

While `/mobile on` is active in a session:

- Every reply coop finishes is posted to your Teams self-chat (the "Notes" chat,
  Graph id `48:notes`), cut at 6,000 characters with a note.
- Every dialog coop raises in that process (the guardrails' write, commit and
  client-data approvals, `/setup-project`'s questions, any extension's
  `confirm`/`select`/`input`) is also posted as a numbered message. The dialog
  stays open in the terminal too. The first answer from either side wins; the
  other dialog closes. A dialog's own timeout still applies, and a timeout is a
  decline.
- Text you type in the chat becomes a prompt to the session, under the same
  guardrails as the terminal. While coop is busy it is queued as a follow-up.
- `/status` answers with the session's state, `/stop` aborts the current turn,
  `/mobile off` turns it off. Other slash commands stay in the terminal.

Nothing listens on the machine. The VM makes outbound HTTPS calls to
`login.microsoftonline.com` and `graph.microsoft.com` only, the same class of
traffic as the model API.

## Setup

### 1. Register the app once (tenant admin, Cooptimize tenant)

Entra admin center, **App registrations**, **New registration**:

| Field | Value |
| --- | --- |
| Name | `coop mobile` |
| Supported account types | Accounts in this organizational directory only |
| Redirect URI | none |
| Authentication, **Allow public client flows** | **Yes** (the device-code flow needs it) |
| API permissions (Microsoft Graph, **Delegated**) | `Chat.ReadWrite`, `User.Read`, `offline_access` |
| Grant admin consent | yes, for the tenant |

No client secret and no certificate: the app is a public client, and the only
credential is the signed-in user's own token. Note the **Application (client)
ID** and the tenant id or domain.

### 2. On each machine, in coop

```text
/mobile setup     # tenant, client id  ->  <profile>\mobile.json
/mobile login     # device code: open the link on any device, enter the code
/mobile on        # per session; asks once in the terminal
```

`/mobile login` pins your user id: only messages written by that user are read.
It also opens the chat and warns when it has more than one member.

To start every session on a machine with mobile on, set `"auto_on": true` in
`mobile.json`. `"chat_id"` can point at another chat (a group chat with a
colleague, for example): everyone in it sees coop's replies, but only your own
messages count.

### 3. On the phone

Open Teams, then the chat with yourself. Coop's messages arrive there; answer an
approval with its number (or `yes`/`no`), or type a prompt.

## Turning it off and revoking

- `/mobile off` ends it for the session; closing coop does too.
- `/mobile logout` deletes `mobile-auth.json` on the machine.
- Entra admin center, the user, **Revoke sessions** invalidates every refresh
  token at once, including coop's on every machine.

`coop doctor` shows whether the machine is set up and signed in.

## Risks to know

- **Your Teams account is the key.** Whoever holds your signed-in phone can
  approve and steer coop. Keep the device lock and MFA on; revoke as above.
- **The machine holds a Graph refresh token** that can read and write your chats
  (not your mail or files). It is DPAPI-protected for your Windows account in
  `<profile>\mobile-auth.json`, so another user on the VM cannot read it; any
  program running as you could, as with every DPAPI secret. Entra rotates the
  token on use and coop keeps the newest. It is revocable from Entra.
- **Session text lives in Teams** under the tenant's retention policy: coop's
  replies, the approval prompts (which name files and commands) and your
  prompts. File contents never post; only coop's reply text does.
- **A prompt from the phone runs with the session's rights** on the machine, as
  one typed in the terminal would. The guardrails ask the same questions.
- **Approvals are explicit and cannot be replayed.** Only `1`/`2`, `yes`/`no`,
  an option number or an option's exact text counts; anything else gets a hint.
  A reply written before the question was posted (by Graph's clock) is ignored
  and says so. No reply means the dialog waits in the terminal or times out as
  declined.
- **Secrets are redacted before posting.** Tokens, keys, signatures and
  `password=`-style values in a reply or a prompt are replaced with
  `[redacted]` in Teams; the terminal still shows the real text. Patterns, not
  understanding: do not rely on it for a value it has never seen.
- Graph throttling (HTTP 429) slows polling down; the session itself is never
  blocked by Teams being unreachable, mobile just stops with a notice.

## Files

| File | What |
| --- | --- |
| `<profile>\mobile.json` | tenant, client id, chat id, `auto_on`, `poll_ms` (minimum 2000) |
| `<profile>\mobile-auth.json` | user id, UPN, protected refresh token |
| `extensions/coop-mobile/index.ts` | the extension; `tests/mobile.test.mjs` its gate tests |
