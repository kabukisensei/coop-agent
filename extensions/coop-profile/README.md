# coop-profile

Injects the local COOP user profile (`~/.coop/user.json`) into each Pi session as
one agent-visible, human-hidden note.

## What it injects

```text
COOP user profile:
- Call the user Aaron.
- Communication: balanced. Answer first, give a brief why, then structured detail.
```

If the profile is missing, malformed, or uses an unknown schema version, the
extension silently does nothing — profile personalization is an aid, not a gate.

## Files

- `index.ts` — extension entry point.
- `package.json` — extension manifest.
- `README.md` — this file.

## Configuration

Set up or edit your profile with:

```bash
coop profile edit
```

The profile is stored in `~/.coop/user.json` and never committed to any project.
