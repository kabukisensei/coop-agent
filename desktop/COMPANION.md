# coop on the phone: the companion contract

Master plan section 12.4. MC1 is this contract; the rules a program can check
are `desktop/lib/companion-protocol.mjs`, checked by
`tests/companion-protocol.test.mjs` against `tests/fixtures/companion/`. MC2 is
the window's side (`desktop/lib/companion-hub.mjs`, `companion-devices.mjs`,
`companion-server.mjs`, `companion-tailscale.mjs`) and MC3 the phone page
(`desktop/companion/`), both checked by `tests/companion-server.test.mjs`.
Nothing listens until someone chooses *Session > Phone* in the window; until
MC4 passes on the VM it is for Aaron only.

## What the phone is

A web page, installable to the home screen on iOS and Android, that shows the
**same live session** an open coop window on the VM is running. It can do four
things and nothing else:

1. read the session: the conversation, whether coop is working, the questions
   it is waiting on;
2. send a chat message;
3. stop the current turn;
4. answer a question coop is waiting on (approvals, picks, text, edits), within
   the limits under "Questions".

The model sign-in, the guardrails, the standards, the files and every tool stay
on the VM. The phone holds one revocable device credential and what is on its
screen. It never starts, switches or ends a session, never runs a shell or one
of Pi's own built-in commands, never reads files, never logs in to a model and
never touches the production unlock (G1). From MC6 it sends the slash commands
Pi lists (extension commands, prompt templates, skills) as typed, as the window
does; `desktop/PARITY.md`'s Phone companion section tracks the rest.

## Two locks, both required

Reaching the page and being allowed to act are separate controls. Either one
alone refuses everything.

**Lock 1, the private connection.** The companion server listens on
`127.0.0.1` only (default port 47821, fixed so the connection can map it; a
taken port is an error in the window, never a fallback to another port or
address). Nothing on the VM's network can reach it. A private connection
carries the phone's requests to that loopback port, and it must itself require
the person's sign-in: no anonymous URL, no public listener. The choice of
connection is recorded under "Decisions" below; the rest of this contract does
not depend on it.

**Lock 2, coop's own device grant.** Every request carries the device
credential, and the window checks it against the live session before anything
else (`checkGrant`). The refusals, each with its own code so the phone can say
which:

| Code | When |
| --- | --- |
| `not-paired` | no credential, or one that matches no device |
| `revoked` | the device was removed in the window |
| `device-expired` | 30 days since pairing, or 7 days unused |
| `wrong-user` | the device was paired by another Windows user |
| `wrong-client` | the device was paired on another client's project, or this window has no client in its project file |
| `access-off` | phone access is off in this window |
| `wrong-session` | the request names a session that is not the live one |

## Identity: one person, one Windows user, one client

- **Pairing happens at the desk.** In the window, *Session > Phone > Pair a
  phone* shows the address and an 8-character code (Crockford letters, no I, L, O or U). It
  lasts 5 minutes, works once, and dies after 5 wrong tries. The phone opens
  the companion address, enters the code, and names itself. Nobody can
  pair without seeing the window, so pairing proves presence at the VM.
- **A device belongs to the Windows user and client it was paired on.** The
  record holds the Windows account (`COMPUTER\user`), the client name from the
  trusted project file (C1), a name, and the times. It lives in that Windows
  user's coop profile (`<profile>\companion\devices.json`), so another client's
  Windows user never sees it and a device paired under one client is refused
  under another (P1: one Windows user per client).
- **The secret is never stored.** Pairing returns a random 256-bit secret as an
  `HttpOnly; Secure; SameSite=Strict; Path=/api` cookie. The VM keeps only its
  SHA-256 and compares in constant time. Page scripts cannot read the cookie.
- **Pair once: phone access is one switch for the app.** *Session > Phone >
  Allow phone access* turns it on or off for every tab and window of this
  Windows user, and the window keeps it in its settings across restarts.
  Pairing a phone turns it on. While it is on, every tab whose project file
  names a client has phone access, through new sessions, switches and
  restarts; a tab with no client never does. Pairing the same phone again
  (its old cookie, or the same name) replaces its old entry.
- **The phone picks the session.** A paired phone uses one open tab on its own
  Windows user and client: the one it chose under *Switch session*
  (`GET`/`POST /api/tabs`), else the focused window's front tab. Tabs on
  another client are never listed or reachable. Both screens show
  *Windows user · client · session · device*. A tab that closes drops the phone
  to the next one.
- **A new session is a new incarnation.** Each Pi start, `/new`, session
  switch, project switch or window restart gets a fresh random id. Every write
  names the incarnation it was made against; one from an older incarnation is
  refused, and its open questions are gone. The phone hears the new
  incarnation on its stream and reloads onto it; access follows the app
  switch.
- **Revoking is immediate.** *Session > Phone > Paired phones* lists each
  device; *Remove* deletes it and closes its open stream at once. *Remove all
  phones* does every device. Signing out on the phone deletes its record too.

## Requests

Twenty routes; anything else is a 404 (`ROUTES`). Bodies are JSON, at most 96 KB,
rebuilt field by field (`validateRequest`); an unknown field is a refusal, not
ignored.

| Route | Body | Does |
| --- | --- | --- |
| `POST /api/pair` | `code`, `deviceName` | trades a pairing code for the device cookie |
| `GET /api/snapshot` | none | the authoritative state: session identity, status, the conversation's messages, open questions, the queue, the `/` commands the phone may send, the last event id |
| `GET /api/events` | none (`Last-Event-ID` header) | the event stream (server-sent events) |
| `POST /api/chat` | `submissionId`, `incarnation`, `text`, `mode`, optional `attachments` | sends a message; while coop works `mode` `steer` sends it now and `queue` waits for the turn to end, as the window's Send now and Queue (MC6); `attachments` names up to ten uploaded files by id (MC10) |
| `POST /api/upload` | `submissionId`, `incarnation`, `name`, `data` (base64) | one photo or file from the phone (MC10), at most 34 MB of body and read only from a paired phone; the window saves it under its own data folder (`phone-uploads`, pruned after seven days) and reads it as the window attaches a file; returns an id, the kind and a detail, never a path |
| `GET /api/files` | `q` in the query | the working folder's file names that match, for `@` mentions (MC10), as the window's composer lists them; names only, never contents |
| `POST /api/stop` | `submissionId`, `incarnation` | stops the current turn (Pi's `abort`) |
| `POST /api/dequeue` | `submissionId`, `incarnation` | takes the queued messages back (Pi's `clear_queue`) and returns their texts for the text box (MC6) |
| `GET /api/detail` | `id` in the query (`t:` a tool call, `m:` an answer) | one tool call's arguments and output, or one answer's thinking, for a tapped line (MC8) |
| `GET /api/sessions` | none | the folder's saved sessions (id, name, first prompt, time, prompt count, which is current) and this session's prompts to fork from (MC9); no paths |
| `POST /api/sessions` | `submissionId`, `incarnation`, `action`, and `sessionId` or `entryId` | one session action (MC9): `new`, `resume` (a listed `sessionId`), `fork` (a listed `entryId`), `clone`, `export` (HTML beside the session file on the VM) or `reload` (the window restarts coop on this session, as its own `/reload`); refused while coop works |
| `GET /api/push` | none | whether notices are set up, the window's VAPID public key, and whether this phone has them on (MC11) |
| `POST /api/push` | `submissionId`, `action` (`on` with `endpoint`, or `off`) | turns notices on or off for this phone; the endpoint must be Apple's, Google's or Mozilla's push service (MC11) |
| `GET /api/tree` | none | the session tree as the window's default view draws it (MC9): one line per prompt, answer or summary, indented where the session branches, a prompt's `entryId` to fork from; tool output stays on the VM |
| `GET /api/session` | none | the session sheets (MC7): model, thinking level and the levels and models Pi lists, the session's name, auto-compact, prompts, answers, tool calls, tokens, cost and context; no file paths |
| `POST /api/session` | `submissionId`, `incarnation`, `action` and its own fields | one session control (MC7): `model` (`provider`, `modelId`, one Pi lists), `thinking` (`level`), `compact` (optional `instructions`, refused while coop works) or `name` (`name`) |
| `POST /api/answer` | `submissionId`, `incarnation`, `questionId`, `digest`, `answer` | answers one open question |
| `GET /api/tabs` | none | the sessions open in the coop window that this phone may use (pair once): tab number, label, folder, session name, working or asking, which one the phone is on |
| `POST /api/tabs` | `submissionId`, `tabId` | uses that open tab from now on; the phone's stream ends and it reloads onto the tab |
| `POST /api/logout` | none | forgets this device |

- **Chat is text and Pi's own `/` commands.** A message starting with `!` is
  refused as `desktop-only`: it runs a shell on the VM. A `/command` goes to Pi
  as typed only when Pi listed it (`get_commands`: extension commands, prompt
  templates, skills); Pi's built-ins wait for their rows or stay in the
  terminal, and the extension screens that exist only in the terminal stay
  there (`phoneCommand`, refused with the reason). At most 16,000 characters.
  Uploaded files go with the chat that names them, as the window sends its
  attachments: images with the prompt (five, 4 MB each, 8 MB together), other
  files by path in the prompt's attachment note, so coop reads them through its
  guarded read tool. An upload waits 30 minutes for its chat and goes once;
  only the phone that uploaded it can send it.
- **Every write is idempotent.** `submissionId` is a UUID the phone makes once
  per action and repeats on every retry. The window remembers each outcome for
  10 minutes and answers a repeat with the first outcome, so a retry after a
  lost reply never sends a message twice, stops twice or answers twice.
- **Cross-site writes are impossible.** Writes need the `Origin` of the
  companion page itself, the header `X-Coop-Companion: 1` and a JSON body
  (`checkOrigin`), on top of the `SameSite=Strict` cookie.
- **Rate limits.** 60 requests a minute per device, 20 answers a minute, 5
  failed pairings an hour per address; over that is `rate-limited`.

## Events and reconnect

The stream carries eight event types (`EVENT_TYPES`), each wrapped with the
session incarnation and a sequence number (`eventEnvelope`). The window maps
Pi's RPC events onto them and drops the rest: thinking, tool arguments and tool
output are never in the stream; a tool shows as its name and a one-line label.
Since MC8 the phone can open one tool call's arguments and output, or one
answer's thinking, when you tap it (`GET /api/detail`). The window keeps the
last 300 of those in memory only, each capped (arguments 4,000 characters,
output and thinking 16,000), and nothing is fetched until a tap.

| Type | Carries |
| --- | --- |
| `status` | idle, running or exited; queued message count |
| `message` | a user or assistant message's text, streamed, then final |
| `tool` | name, one-line label, running / done / error |
| `question` | an open question, as "Questions" below describes it |
| `question_resolved` | answered, expired or cancelled, and by desktop, phone or Pi |
| `notice` | an extension's notice (info, warning, error) |
| `session` | the identity line: incarnation, Windows user, client, session name |
| `panel` | the status line, the widgets and the todo panel above the prompt (MC8) |

**Reconnect.** The window keeps the last 2,000 events or 15 minutes. A phone
coming back sends the last id it saw; the window replays the tail only when it
is the same incarnation and nothing is missing, and otherwise tells the phone to
reload the snapshot (`resumePoint`). The phone disables every button until the
snapshot or replay has arrived, and it never re-sends an answer it is unsure
about: an unacknowledged answer is retried with the same `submissionId`, which
returns the first outcome, or shown as resolved by the snapshot.

**Honest status.** The phone shows *running*, *idle*, *exited* (Pi ended; the
desktop must restart it) or *disconnected* (no stream). A lost connection is
never read as an answer or as approval.

## Questions

A question is a Pi dialog (`select`, `confirm`, `input`, `editor`) from any
extension: guardrails approvals, `ask_user_question` cards, the setup forms.
The window owns it: its id (`questionId`, opaque and different in every
incarnation), its exact text and options, its expiry. For each one the window
decides what the phone may do (`classifyQuestion`):

- **Answerable** on the phone: the same card the desktop draws
  (`desktop/renderer/dialogs.mjs`), with the command or SQL as code.
- **Only the options Pi offered, minus any that widen the grant.** An option
  that approves more than the one action shown ("Allow ... edits for this
  session", "always", "don't ask again") stays on the desktop; the phone shows
  how many were held back. A phone approval covers exactly one action.
- **Production writes are desktop-only.** A question that says `PRODUCTION`
  (G1 writes it on every production write: the typed client-name permit, or
  the yes/no under a human unlock) is shown read-only on the phone with
  *Continue on the desktop*. The phone can still decline it. The unlock is a
  terminal command the phone has no route to.
- **The answer must match the exact action.** The phone returns the
  question's `digest`, a SHA-256 over method, title, message and options as Pi
  sent them (`actionDigest`). A different command text is a different digest.

**First answer wins** (`decideAnswer`). The window checks, in one synchronous
step with the state change: the incarnation, that the question exists and is
still open, the digest, that the phone may give that answer, and that a pick is
one of the allowed options. The first valid answer from either screen goes to
Pi; the question becomes answered and `question_resolved` closes the card on
both screens. A later answer gets `already-answered`; one after expiry or
cancellation gets `expired` or `cancelled`; a stale card gets `changed` or
`wrong-session`. Declining (No, Cancel, or the extension's own Decline) is
always available and is the default focus. Timeouts are Pi's and the
extension's, enforced on the VM whether or not a phone is awake.

**What the phone cannot show** says *Continue on the desktop* and leaves the
question open: anything an extension draws in the terminal only (Pi's RPC mode
drops custom components already), Windows sign-in, UAC and browser or model
sign-in pages. Those need a remote desktop session.

## Storage on the phone

- The device cookie, as above. No credential in `localStorage`, IndexedDB or
  the service worker.
- The service worker caches the page's own static files only. No API response,
  message or question is written to any cache; closing the page leaves no
  transcript on the phone.
- The theme choice (Modern or Retro, dark or light; on the phone Retro is the
  coop website's look, MC5) may be kept in `localStorage`. Retro's Silkscreen
  font ships with the page.
- The page is served with `Content-Security-Policy: default-src 'self';
  script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src
  'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, no
  inline script, and Markdown rendered with HTML escaped, as the desktop does.
- Notices (MC11, Aaron said yes 2026-10-06 03:34) are off until the phone
  turns them on in the menu. When coop asks a question or finishes a turn,
  access is on and the phone's page is closed, the window sends that phone
  a web push with **no payload**, one a minute at most. The push service
  (Apple's or Google's) learns only that a push was sent, and the phone shows
  the fixed line "coop is waiting for you": never a client name, question,
  command or answer. The window keeps one VAPID key pair per Windows user
  (`<profile>\companion\push.json`) and only the subscription's endpoint on
  the device record, and sends only to Apple's, Google's or Mozilla's push
  hosts. On an iPhone, notices need coop on the Home Screen (iOS 16.4 or later).

## Audit

Each Windows user's profile gets `logs\companion.jsonl`: one line per pairing,
refused request (with its code), answer (question id, outcome, which screen),
stop, revoke, access on/off, notices turned on or off and each notice sent (the push service's status), with the time and the device id. Never message
text, answers' values, cookies or codes.

## Decisions (MC1)

Recorded for Aaron's review before MC2 and MC3 start. Each default can change
in review without touching the rest.

| Decision | Default |
| --- | --- |
| Private connection | **Tailscale** (Aaron, 2026-10-06 02:17, "2"): `tailscale serve` publishes the loopback port as `https://<vm>.<tailnet>.ts.net` inside the tailnet only, with its own certificate; never `tailscale funnel` |
| Device lifetime | 30 days from pairing, 7 days idle, revocable at once |
| Pairing code | 8 characters, 5 minutes, one use, 5 tries |
| Access | pair once (Aaron, 2026-10-07): one app-wide switch, on from pairing and kept across restarts; every tab on the phone's client, picked under *Switch session* |
| Reconnect retention | 2,000 events or 15 minutes, then reload the snapshot |
| Idempotency memory | 10 minutes per `submissionId` |
| Chat | text, 16,000 characters, no `!`; Pi's listed `/` commands; steer or queue while busy (MC6) |
| Session-wide and production approvals | desktop only; the phone may decline |
| Phones | iOS 17+ Safari and Android 12+ Chrome, in the browser and installed to the home screen |
| Extension UI on the phone | the four dialog kinds and `ask_user_question` cards; notices as `notice`; everything else *Continue on the desktop* |
| Security review and VM tester | Aaron, at MC4 |

**The private connection, options considered.** Any of them sits in front of
the same loopback server and the same device grant. Aaron picked Tailscale on
2026-10-06 at 02:17 after confirming Cooptimize manages its own VMs, so client
IT consent is not a factor.

1. **Microsoft dev tunnel, private to Aaron's Cooptimize account.** The VM runs `devtunnel host` (outbound HTTPS only, no
   inbound port or firewall rule); the phone signs in with the Cooptimize
   Microsoft account (MFA, conditional access) before it reaches the page.
   Traffic passes through Microsoft's relay in transit, under the Cooptimize
   tenant, which the client-data rule allows. Cost: one Microsoft tool on the
   VM and a sign-in on the phone; Microsoft labels it for development and
   testing, with a monthly bandwidth cap.
2. **Tailscale (recommended, 2026-10-06, since Cooptimize manages its own
   VMs).** End-to-end encrypted from phone to VM, so no relay or provider can
   read the session; Tailscale's servers only introduce the devices. The app
   runs on the VM (admin install, a network adapter) and the phone; business
   use is a paid per-user plan. No client data reaches Tailscale.
3. **The client's own network or VPN.** No new service: the phone joins the
   client's VPN and reaches the VM directly. Only works where the client gives
   the phone that access, and the server would then listen on the VM's private
   address instead of loopback.

## Setting it up (Tailscale)

Once per VM, and once per phone. Nothing here changes the terminal coop.

1. **Tailscale on the VM.** Install Tailscale for Windows from
   `https://tailscale.com/download/windows` (needs admin), sign in with the
   Cooptimize account, then in a normal PowerShell window run
   `tailscale serve --bg 47821`. That publishes coop's loopback port as
   `https://<vm>.<tailnet>.ts.net`, inside the tailnet only (the first time,
   Tailscale asks to turn on MagicDNS and HTTPS certificates for the tailnet).
   Never use `tailscale funnel`, which would make it public.
2. **Tailscale on the phone.** Install the Tailscale app (App Store or Google
   Play) and sign in with the same account.
3. **Pair.** In the coop window, open the client's project, then *Session >
   Phone > Pair a phone*. On the phone, with Tailscale on, open the address
   the window shows, enter the code and name the phone. Add it to the home
   screen (Safari: Share > Add to Home Screen; Chrome: menu > Add to Home
   screen / Install app).
4. **Use.** Pairing turns *Session > Phone > Allow phone access* on, for the
   app and across restarts. The phone shows the conversation, coop's status
   and its questions; send a message, stop a turn, or answer, and the rest is
   in its menu. *Switch session* in the phone's menu moves between the tabs
   open on its client.
5. **Notices (optional).** In the phone's menu, *Notices > Turn notices on*.
   On an iPhone this works only from the Home Screen app (iOS 16.4 or later).
   The VM needs to reach Apple's and Google's push services over HTTPS.

coop reads the address from `tailscale status --json`. The window's
`settings.json` key `companionOrigin` (an `https://` address) overrides it.
The audit log is `<profile>\logs\companion.jsonl`; the paired phones are in
`<profile>\companion\devices.json`.
