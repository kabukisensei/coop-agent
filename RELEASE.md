# Releasing the coop-* suite

Cross-repo runbook. The suite is four sibling repos (same GitHub owner, all
released from `main`, checked out side by side): **coop-data-doc** and
**coop-schema-compare** (Python → PyPI, both pinned in
`config/release-manifest.json` `python_tools`), **coop-agent** (this repo), and
**coop-website** (static site). Release **in the order below** — the Python
tools first, website last.

`coop-review-core`, `coop-dax-review` and `coop-sql-review` are **archived**
(master plan ST1 retired the review CLIs; their rules now live in the
`cooptimize/coop-standards` wiki, which coop reads at launch and is not released
through this runbook). They are no longer part of a suite release. coop does ship
a **bundled copy** of that wiki for first runs and offline machines
(`config/standards-bundle/`); refresh it as part of the coop-agent release (step
(b) below).

## When to release — explicit instruction only

Run this runbook **only when Aaron explicitly asks for a release in the current
conversation, naming the repo(s) and the version or bump level.** A clean
working tree, a merged PR, a finished task, or an updated CHANGELOG is **never**
a release trigger — on 2026-07-02 an agent cut a spurious, empty release by
treating a "clean tree" signal as permission while another agent shared the
working tree. Never auto-release; if unsure whether a release was requested,
stop and ask.

**Definition of done:** a suite release is **not finished** until coop-website
is synced and that pull request is merged. coop-agent's `release.yml` dispatches
the site's sync-release workflow when `COOP_WEBSITE_DISPATCH_TOKEN` is set.
That workflow updates `versions.json`, badges and the changelog and opens the
pull request. Without the secret, the GitHub Release is still published and
the website job prints a notice; run sync-release by hand (step (c)). Pushing
the site's `main` deploys.

## What publishes automatically on a `v*` tag push

| Repo | Pushing tag `vX.Y.Z` triggers | Version source (single source of truth) |
| --- | --- | --- |
| coop-data-doc | `publish.yml`: build → wheel smoke-test → **PyPI** → GitHub Release | `src/coop_data_doc/__init__.py` `__version__` |
| coop-agent | `release.yml`: **GitHub Release** (body = that version's CHANGELOG section), then a `repository_dispatch` (`coop-release`, `{repo, tag}`) to coop-website when `COOP_WEBSITE_DISPATCH_TOKEN` is set. Nothing goes to npm/PyPI | `VERSION` file + `extensions/*/package.json` (lockstep, managed by `coop release`) |
| coop-website | no tags of its own. coop-agent's `website` job dispatches `coop-release`, or you run Actions → sync-release by hand; that opens a pull request. **Pushing to `main` deploys** the site. CI (`check.yml`) gates version-sync + link checks on every push/PR | `versions.json` in the repo root — every HTML badge/mention must match it (`scripts/check-versions.sh` enforces) |

coop-data-doc's `publish.yml` **verifies the pushed tag equals
`__version__` exactly** and fails the whole publish otherwise.

**Guardrails — never do these:**

- **Never** tag before bumping `__version__` (coop-data-doc) — the publish fails
  and a published PyPI version can never be reused.
- **Never** force-push, delete, or re-push a `v*` tag.
- **Never** add a `version =` field to coop-data-doc's `pyproject.toml` —
  the version is hatch-dynamic from `__init__.py`.
- **Never** hand-edit coop-agent's `VERSION` or `extensions/*/package.json` —
  `coop release` owns them.
- **Never** release from a dirty tree. Check first: `git status --porcelain`
  must print nothing.
- **Never** push a coop-agent tag on its own: it must land on `main`, so
  `coop release` refuses a detached HEAD or a `main` that differs from
  `origin/main` and pushes `main` and the tag atomically (see step (b)).
- **Never** treat a clean tree as permission to release — a release happens only
  on Aaron's explicit request naming the version (see "When to release" above).

## (a) coop-data-doc — FIRST, and only if it changed

The version source is `src/coop_data_doc/__init__.py` `__version__`, and **the
tag must match it exactly or `publish.yml` fails**.

```bash
cd ../coop-data-doc
git pull
git status --porcelain                 # expect: empty
```

1. Bump the version — the ONLY place it lives:
   edit `src/coop_data_doc/__init__.py` → `__version__ = "X.Y.Z"`.
2. Test + lint with the repo's own venv (system `python3` lacks the deps; CI
   gates the same):

   ```bash
   .venv/bin/python -m pytest -q
   .venv/bin/python -m ruff check src tests
   .venv/bin/python -m ruff format --check src tests
   ```

   Expected: pytest reports all passed; ruff prints nothing / "All checks passed".
   If the venv is ever missing ruff, add it with `.venv/bin/pip install ruff`
   (CI installs its own and gates the same checks regardless).
3. Commit and push `main` (coop-data-doc has no CHANGELOG; its release tag is
   the record):

   ```bash
   git add src/coop_data_doc/__init__.py
   git commit -m "Release vX.Y.Z"
   git push origin main
   ```

4. Tag **exactly** `vX.Y.Z` (must match `__version__`) and push it:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. Verify the workflow succeeded: `gh run watch` (or check the repo's Actions
   tab) — the run must show build, smoke-test, PyPI publish, GitHub Release all
   green.
6. Verify on PyPI (allow a minute for the index):

   ```bash
   curl -s https://pypi.org/pypi/coop-data-doc/json | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["version"])'
   ```

   Expected output: `X.Y.Z`.

## (b) coop-agent (this repo)

coop-agent does **not** publish to a registry. Teammates get it when
`coop update` fast-forwards their checkout to the newest `vX.Y.Z` tag on
`main` whose `VERSION` file is that same number, so **pushing the tag is the fleet deployment**. A merge to `main`
alone reaches only maintainers on `coop update --edge`. The whole release is
a pull request and then one command; see also [CONTRIBUTING.md](CONTRIBUTING.md#cutting-a-release).

Every extension or Pi pin change must already carry a regenerated
`config/extensions-lock.json` (`node lib/extlock.js generate`, see
`CONTRIBUTING.md`); the gate lane fails otherwise, so `coop release` stops before
tagging a manifest whose lock drifted.

If this suite release also bumped a coop tool (step (a)), **run
`bash scripts/bump-pins.sh`** (or `bump-pins.sh coop-data-doc=1.4.4` for one
tool): it writes the `python_tools` pin in `config/release-manifest.json`, the
one place a tool pin is written, and for a GitHub-release wheel the tag, asset
and sha256 too, then prints the CHANGELOG line. Nothing else carries a literal
pin: the fixtures, `NOTICE.md` and the client-home CI template read the
manifest (the template keeps `coop-data-doc==<version>`, rendered at copy
time), and `tests/pins.test.sh` fails the bump PR if a stale `<tool>==<old>`
literal is left anywhere. The pre-tag gate below verifies the pin against
coop-website's `versions.json` and aborts on a mismatch. (Update the sibling
checkout's `versions.json` before or together with the pin. The website job
opens the site's sync pull request only after this tag is published, so that
gate still reads the checkout you have, not the pull request.)

**Refresh the bundled standards copy** so the release ships the wiki as it is
today (first runs and offline machines read it until `coop sync` reaches the
wiki): from a clean clone of `cooptimize/coop-standards` on `main`, run
`node lib/standards-cli.mjs bundle-update <path to that clone>`, then
`node lib/standards-cli.mjs bundle-check` (exit 0), and commit
`config/standards-bundle/` as `standards: bundle wiki @ <short revision>`. The
gate lane fails if the bundle does not verify, and `coop release` compares the
bundle's revision with the wiki's `main` head before tagging: a bundle behind
the wiki stops the release (`--no-check` skips it), an unreachable wiki warns
and asks.

The release is two steps: a release pull request, then the tag.

**1. The release pull request.** Actions -> release-pr -> Run workflow, with
`patch`, `minor`, `major` or an explicit `X.Y.Z` (or by hand:
`git switch -c release/vX.Y.Z main`, `bash scripts/bump-version.sh patch`,
commit as `Release vX.Y.Z`, push, open the PR). The workflow needs the
`COOP_RELEASE_TOKEN` secret (a fine-grained token on this repository with
Contents and Pull requests read/write), because a branch pushed with the
workflow's own token gets no CI on its PR. The PR moves `VERSION`,
`config/release-manifest.json`'s `coop_version` and every
`extensions/*/package.json` in lockstep and rolls `## [Unreleased]` into a dated
`## [X.Y.Z]`. CI runs the gate lane on it, and `extended.yml` runs too (it runs
on any PR that changes `VERSION`), so the release PR carries the full suite's
evidence. Merge it under the usual rule once both are green; the push to `main`
runs `ci.yml` again with the installer upgrade acceptance.

**2. The tag.** From a clean tree on `main` at `origin/main`:

```bash
./bin/coop release        # add --yes to skip the confirm
```

What `coop release` does (`scripts/release.sh`, the one maintainer command that
stays in bash; `./bin/coop release` runs it, and on Windows `bin/coop.ps1`
forwards to Git Bash): requires a clean tree; fetches `origin` and refuses
unless `HEAD` is the branch `main` at exactly `origin/main`; checks that
`VERSION`, the manifest and every extension agree on one `X.Y.Z`, that
`CHANGELOG.md` has that section and that no `vX.Y.Z` tag exists here or on
origin (otherwise it names the release PR as the fix: the bump is never done
here); reads GitHub's check runs for the exact commit and continues only when
they are all complete and green (still running, red, none, or GitHub
unreachable stop it); verifies the coop-tool `python_tools` pins in
`config/release-manifest.json` against the sibling `../coop-website/versions.json`
(a mismatch aborts with the fix named; a missing sibling warns and asks) and the
bundled standards against the wiki's head; `--no-check` skips those three
gates. Then it tags `vX.Y.Z` and pushes the tag. There is no local test run: the
release PR and the merge commit ran every suite on these bytes.

The tag push runs `release.yml`: it refuses a tag that is not `v$(cat VERSION)`
or not an ancestor of `origin/main`; its `installer` job builds the coop window
installer from the tag and runs the whole acceptance on those exact bytes
(`desktop/scripts/verify-installer.mjs`, then the upgrade from the previous
release, the shortcut launch and the one-liner, as `ci.yml` runs on every push
to `main`); the release job publishes the executable only when the acceptance
report says ok and names the executable's SHA-256
(`desktop/scripts/check-installer-report.mjs`), with that version's CHANGELOG
section as the body. The `website` job (`needs: [release]`) then dispatches
`repository_dispatch` event `coop-release` to kabukisensei/coop-website with
`client_payload` `{repo, tag}`, `repo` this repository's name and `tag` the
pushed tag (`github.ref_name`, `vX.Y.Z`). This workflow has no
`workflow_dispatch` and no `inputs.tag`; the release job's `version` output is
the same tag with the leading `v` removed, which the site's receiver rejects.
The call needs the `COOP_WEBSITE_DISPATCH_TOKEN` secret. Without it the job
prints a notice and exits 0, and you run the site's sync-release workflow by
hand (step (c)). coop-website is private, so the job sends a
`repository_dispatch`. A `uses:` of a workflow in that repository fails the
tag run at planning (v0.38.7). A failed acceptance fails the tag run with no
release created; fix, then release the next patch (never re-push a tag).

Verify:

```bash
git describe --tags             # expect: vX.Y.Z
gh release view vX.Y.Z          # expect: release exists, body = the CHANGELOG section
```

If the tag push is rejected, nothing reached origin and `coop release` exits
non-zero with the retry command.

**Deployment, rollback, and holds (coop-agent).**

- **Rollback is a new tag.** `coop update` never moves a checkout backwards, so
  a manual `git checkout <older tag>` is undone by the next update. Roll the
  fleet back by reverting on `main` and cutting a new patch release. Never
  delete, move, or re-push a tag; machines keep their local copy.
- **A hold is a branch that does not track `origin/main`.** Default
  `coop update` leaves it alone, so it pins one machine:
  `git -C <coop-agent> switch -c hold vX.Y.Z`, then `coop update` (the tools
  pin to that tag's manifest). Leave it with `git -C <coop-agent> switch main`,
  then `coop update`. A hold stays attached, so one at any tag is safe. Never
  leave a teammate **detached** at a tag from before the release that shipped
  this updater (v0.23.5 or older): that updater cannot move a detached
  checkout. Recovery: `git -C <coop-agent> checkout main`, then `coop update`.
- **A release that changes `scripts/update.*` takes effect on the second
  update after it lands**: the first run still executes the updater that was
  already loaded. (A release that changes only the manifest pins and the
  extension lock converges in one run: the updater re-reads the fleet plan after
  the checkout moves.) If a release breaks `coop update` itself, teammates recover
  with `git -C <coop-agent> fetch origin`, then
  `git -C <coop-agent> merge --ff-only vX.Y.(Z+1)`, then `coop update`.
- **Never start tracking a path that `.gitignore` ignores** in a release. The
  fast-forward refuses to overwrite an untracked file, but git overwrites an
  ignored one without asking.
- **Fresh installs**: a plain clone starts on the head of `main` and joins the
  release channel at the next tag.

## (c) coop-website — LAST

No tags on the site: **pushing to `main` deploys**. The site hard-codes tool
versions in its HTML, with `versions.json` (repo root) as the declared single
source of truth — CI (`check.yml`) fails any push/PR where they drift.

The sync is automatic once this repository has the
`COOP_WEBSITE_DISPATCH_TOKEN` secret (a fine-grained PAT whose only repository
is kabukisensei/coop-website, Contents: Read and write — the minimum for
`POST /repos/{owner}/{repo}/dispatches`). After the GitHub Release is
published, `release.yml`'s `website` job sends `repository_dispatch`
event_type `coop-release` with `client_payload` `{repo, tag}`: `repo` is
`coop-agent` and `tag` is `vX.Y.Z`. coop-website's sync-release workflow (the
receiver from its PR #105) checks that pair, updates `versions.json`, the
badges and the changelog, runs the site's check scripts, and opens the pull
request. Review it, merge it, and the push to `main` deploys.

Without the secret, the website job prints a notice and exits 0. The release
is already published. Run the sync-release workflow in
kabukisensei/coop-website by hand: Actions → sync-release → Run workflow, with
repo `coop-agent` and tag `vX.Y.Z` (the tag must match `^v\d+\.\d+\.\d+$`).

coop-website's own `AGENTS.md` > "Release-time procedure" is the canonical
description of the edits that workflow applies. A pre-tag pin check still
reads the sibling checkout's `versions.json` (step (b)); pull that checkout
when a tool's sync pull request has merged and you are about to tag
coop-agent.
