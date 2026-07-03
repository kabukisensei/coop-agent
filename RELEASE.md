# Releasing the coop-* suite

Cross-repo runbook. The suite is six sibling repos (same GitHub owner, all
released from `main`, checked out side by side): **coop-review-core**,
**coop-dax-review**, **coop-sql-review**, **coop-data-doc** (Python → PyPI),
**coop-agent** (this repo), and **coop-website** (static site). Release **in
the order below** — core first, website last.

## When to release — explicit instruction only

Run this runbook **only when Aaron explicitly asks for a release in the current
conversation, naming the repo(s) and the version or bump level.** A clean
working tree, a merged PR, a finished task, or an updated CHANGELOG is **never**
a release trigger — on 2026-07-02 an agent cut a spurious, empty release by
treating a "clean tree" signal as permission while another agent shared the
working tree. Never auto-release; if unsure whether a release was requested,
stop and ask.

**Definition of done:** a suite release is **not finished** until coop-website
is synced and pushed — `versions.json` updated **first**, then badges /
cache-bust, and **both** check scripts (`check-versions.sh`, `check-links.sh`)
PASS. See step (e).

## What publishes automatically on a `v*` tag push

| Repo | Pushing tag `vX.Y.Z` triggers | Version source (single source of truth) |
| --- | --- | --- |
| coop-review-core | `publish.yml`: build → wheel smoke-test → **PyPI** → GitHub Release | `src/coop_review_core/__init__.py` `__version__` |
| coop-dax-review | same → **PyPI** | `src/coop_dax_review/__init__.py` `__version__` |
| coop-sql-review | same → **PyPI** | `src/coop_sql_review/__init__.py` `__version__` |
| coop-data-doc | same → **PyPI** | `src/coop_data_doc/__init__.py` `__version__` |
| coop-agent | `release.yml`: **GitHub Release only** (body = that version's CHANGELOG section). Nothing goes to npm/PyPI | `VERSION` file + `extensions/*/package.json` (lockstep, managed by `coop release`) |
| coop-website | nothing — tags are not used; **pushing to `main` deploys** the site. CI (`check.yml`) gates version-sync + link checks on every push/PR | `versions.json` in the repo root — every HTML badge/mention must match it (`scripts/check-versions.sh` enforces) |

Every Python repo's `publish.yml` **verifies the pushed tag equals
`__version__` exactly** and fails the whole publish otherwise.

**Guardrails — never do these:**

- **Never** tag before bumping `__version__` (Python repos) — the publish fails
  and a published PyPI version can never be reused.
- **Never** force-push, delete, or re-push a `v*` tag.
- **Never** add a `version =` field to a Python repo's `pyproject.toml` —
  versions are hatch-dynamic from `__init__.py`.
- **Never** hand-edit coop-agent's `VERSION` or `extensions/*/package.json` —
  `coop release` owns them.
- **Never** release from a dirty tree. Check first: `git status --porcelain`
  must print nothing.
- **Never** treat a clean tree as permission to release — a release happens only
  on Aaron's explicit request naming the version (see "When to release" above).

## (a) coop-review-core — FIRST, and only if it changed

Core is a runtime dependency of coop-dax-review and coop-sql-review (their
suppression/diagnostics/upgrade modules are thin shims over it), so it must be
on PyPI **before** they release against it.

```bash
cd ../coop-review-core
git pull
git status --porcelain                 # expect: empty
```

1. Bump the version — the ONLY place it lives:
   edit `src/coop_review_core/__init__.py` → `__version__ = "X.Y.Z"`.
2. Test + lint with the repo's own venv (system `python3` lacks the deps; CI
   gates the same):

   ```bash
   .venv/bin/python -m pytest -q
   .venv/bin/python -m ruff check src tests
   .venv/bin/python -m ruff format --check src tests
   ```

   Expected: pytest reports all passed; ruff prints nothing / "All checks passed".
   All four Python repos' venvs carried ruff + pytest as of 2026-07-02; if one
   is ever missing ruff, add it with `.venv/bin/pip install ruff` (CI installs
   its own and gates the same checks regardless).
3. Commit and push `main` (no CHANGELOG here — coop-review-core and
   coop-data-doc have none; coop-dax-review and coop-sql-review do):

   ```bash
   git add src/coop_review_core/__init__.py
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
   curl -s https://pypi.org/pypi/coop-review-core/json | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["version"])'
   ```

   Expected output: `X.Y.Z`.

## (b) Bump the core dependency floor (only if the core API changed)

If dax/sql rely on something new in core, raise the floor in **both**
`coop-dax-review/pyproject.toml` and `coop-sql-review/pyproject.toml`:

```toml
"coop-review-core>=X.Y.Z",
```

Verify: `grep -n "coop-review-core" pyproject.toml` in each repo shows the new
floor. This change ships with each tool's own release in step (c).

## (c) coop-dax-review, coop-sql-review, coop-data-doc

Same procedure as (a), per repo — the version source is
`src/<pkg>/__init__.py` `__version__`, and **the tag must match it exactly or
`publish.yml` fails**:

1. `git pull`, clean tree, bump `__version__`.
2. coop-dax-review and coop-sql-review: update `CHANGELOG.md`.
   coop-data-doc: no CHANGELOG.
3. Test + lint with the repo's `.venv` (as in (a)).
4. Commit, push `main`, tag `vX.Y.Z`, push the tag.
5. Verify the Actions run is green, then verify each on PyPI:

   ```bash
   curl -s https://pypi.org/pypi/coop-dax-review/json  | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["version"])'
   curl -s https://pypi.org/pypi/coop-sql-review/json  | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["version"])'
   curl -s https://pypi.org/pypi/coop-data-doc/json    | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["version"])'
   ```

## (d) coop-agent (this repo)

coop-agent does **not** publish to a registry; teammates get it via
`coop update` (git pull). The whole release is one command — see also
[CONTRIBUTING.md](CONTRIBUTING.md#cutting-a-release).

From a clean tree on `main`, with user-visible changes recorded under
`## [Unreleased]` in `CHANGELOG.md`:

```bash
./bin/coop release patch        # or: minor | major   (default: patch); add --yes to skip the confirm
```

What `coop release` does (`coop_release` in `bin/coop`): requires a clean tree;
runs the pre-tag gate — esbuild-checks every `extensions/*/index.ts`, then
`bash tests/run.sh` and `bash scripts/check-parity.sh` (all skippable with
`--no-check`); bumps the `VERSION` file **and** every `extensions/*/package.json`
in lockstep; rolls
`## [Unreleased]` into a dated `## [X.Y.Z]`; commits `Release vX.Y.Z`; tags
`vX.Y.Z`; pushes commit + tag (`--no-push` stops at the local tag). The tag
push triggers `release.yml`, which cuts a GitHub Release whose body is that
version's CHANGELOG section.

Verify:

```bash
git describe --tags             # expect: vX.Y.Z
gh release view vX.Y.Z          # expect: release exists, body = the CHANGELOG section
```

## (e) coop-website — LAST

No tags: **pushing to `main` deploys**. The site hard-codes tool versions in
its HTML, with `versions.json` (repo root) as the declared single source of
truth — CI (`check.yml`) fails any push/PR where they drift. The site still
drifts every suite release unless you update it. coop-website's own
`AGENTS.md` > "Release-time procedure" is the canonical detailed version of
these steps.

```bash
cd ../coop-website
git pull
```

1. **Edit `versions.json` first**: set the new product version(s); if any
   js/css changed, also increment `"cache_bust"` by exactly 1. Keep its
   strict one-`"key": "value"`-per-line layout — the checker parses it with
   sed, not a JSON parser.
2. Update the **version badges**: each `docs/*.html` carries
   `<span class="version-label">vX.Y.Z</span>` in a `doc-version` line (plus a
   "docs last updated" date). Pages track the repo they document —
   `data-doc.html` → coop-data-doc, `sql-review.html` → coop-sql-review,
   `dax-review.html` → coop-dax-review, everything else → coop-agent. Sample
   `coop doctor` output and JSON examples on those pages can also embed
   versions — search each touched page for the OLD version string:

   ```bash
   grep -rn "vOLD.X.Y" index.html docs/
   ```

3. If any js/css changed, bump the **cache-bust query** `?v=NN` → `?v=NN+1`
   (to match the new `"cache_bust"`) on every asset reference across **all**
   HTML files (they must stay identical; 50 references as of `?v=15`):

   ```bash
   grep -rno '?v=[0-9]*' index.html docs/*.html | sort -t= -k2 | uniq -c -f1
   ```

4. Verify no drift — run the same two checks CI runs, and re-run after fixing
   each reported `DRIFT:` / `BROKEN:` line until both pass:

   ```bash
   bash scripts/check-versions.sh   # expect: "PASS: ..." and exit 0
   bash scripts/check-links.sh      # expect: "PASS: ..." and exit 0
   ```

5. Commit, push `main`, then spot-check the live site (badge versions + a
   hard-refresh for the new assets).
