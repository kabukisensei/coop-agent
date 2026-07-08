#!/usr/bin/env python3
"""Shared Azure DevOps helpers for coop's boards tooling (digest + onboarding).

Dependency-free by design: standard library only, plus coop's own dependency-free
YAML reader (lib/_yaml.py). We do NOT depend on `requests` or `PyYAML` — fresh
machines (especially Windows workstations) frequently lack both, and the repo's
rule is "never assume PyYAML is installed" (see CLAUDE.md). All HTTP goes through
urllib; all config parsing goes through lib/_yaml.

What lives here (kept out of the two entry scripts so they stay thin and consistent):
  * config loading + defaults merge (load_config)
  * per-client auth / token minting (azcli | pat | sp)  -> auth_header(client)
  * a small Azure DevOps REST client (AdoClient) built on the VERIFIED endpoints:
      POST {org}/{project}/_apis/wit/wiql            (WIQL -> ids)
      POST {org}/_apis/wit/workitemsbatch            (ids -> fields, <=200/call)
      GET  {org}/{project}/{team}/_apis/work/teamsettings/teamfieldvalues
      GET  {org}/{project}/_apis/wit/workitemtypes/{type}/states
      GET  {org}/_apis/projects , .../teams          (onboarding discovery)
      GET  https://app.vssps.visualstudio.com/_apis/profile/profiles/me , /accounts
    (`az boards query --wiql` is deliberately NOT used — it silently returns empty
     against real projects; see the plan's verified-facts section.)
  * WIQL builders for the three watchdog buckets (open / stale / unassigned)
  * identity mapping (merge an org's duplicate `Ext-`/member identities to one person)
  * strict redaction so tokens / PATs / Authorization headers never surface.

Confidentiality: this module contains NO client names, orgs, projects, people, or
addresses. Everything client-specific is read at runtime from the private config
(~/.coop/devops/clients.yml), never from anything in this repo.
"""

import base64
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# --- Constants ---------------------------------------------------------------

API_VERSION = "7.1"
# Azure DevOps' well-known Entra resource/audience id — a fixed public GUID, not a
# secret. A bearer token minted for it is accepted by dev.azure.com REST APIs.
ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
VSSPS_BASE = "https://app.vssps.visualstudio.com"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"

DEFAULT_CONFIG = os.path.join(os.path.expanduser("~"), ".coop", "devops", "clients.yml")

# Fields fetched for every work item in a digest.
DIGEST_FIELDS = [
    "System.Id",
    "System.Title",
    "System.WorkItemType",
    "System.AssignedTo",
    "System.State",
    "System.ChangedDate",
    "System.IterationPath",
    "System.AreaPath",
    "System.Tags",
]

WORKITEMS_BATCH_MAX = 200          # hard API cap per workitemsbatch call
WIQL_TOP = 20000                   # WIQL hard-errors above ~20k results; cap below it
DEFAULT_STALE_DAYS = 14
DEFAULT_WORK_ITEM_TYPES = ["User Story", "Feature"]


class AdoError(Exception):
    """A per-client failure. Callers catch this to skip one client and continue."""


# --- Config ------------------------------------------------------------------

def _import_yaml_reader():
    """Import coop's dependency-free YAML reader (lib/_yaml.py) without polluting
    sys.path for the caller beyond what's needed."""
    lib_dir = str(Path(__file__).resolve().parent.parent / "lib")
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    import _yaml  # noqa: E402  (path set above)
    return _yaml


def config_path(override=None):
    """Resolve the config path: explicit arg > $COOP_DEVOPS_CONFIG > default."""
    return override or os.environ.get("COOP_DEVOPS_CONFIG") or DEFAULT_CONFIG


def state_dir(cfg_path):
    """State files live next to the config, under state/ (outside any repo)."""
    d = os.path.join(os.path.dirname(os.path.abspath(cfg_path)), "state")
    return d


def load_config(override=None):
    """Read and normalize the clients config. Returns the parsed dict with
    per-client defaults applied. Raises AdoError if the file is missing/unreadable."""
    path = config_path(override)
    if not os.path.isfile(path):
        raise AdoError(
            "config not found: %s\n"
            "Create it from config/devops.clients.example.yml (or run ado-onboard)."
            % path
        )
    yaml = _import_yaml_reader()
    try:
        data = yaml.load(path)
    except Exception as exc:  # a genuine YAML syntax error
        raise AdoError("could not parse %s: %s" % (path, exc))
    if not isinstance(data, dict):
        raise AdoError("config %s did not parse to a mapping" % path)
    data.setdefault("defaults", {})
    data.setdefault("clients", [])
    # Fail fast if two client keys collapse to the same PAT env-var name — otherwise the
    # second client would silently authenticate with the first's PAT against a different org.
    env_seen = {}
    for c in data["clients"]:
        if not isinstance(c, dict) or not c.get("key"):
            continue
        en = _env_pat_name(c["key"])
        if en in env_seen and env_seen[en] != c["key"]:
            raise AdoError("client keys %r and %r both map to PAT env var %s — make the keys distinct"
                           % (env_seen[en], c["key"], en))
        env_seen[en] = c["key"]
    data["_config_path"] = path
    return data


def safe_key(key):
    """Sanitize a client key for use in a filename (state files). Keeps [A-Za-z0-9_-]."""
    return "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in str(key)) or "client"


def client_defaults(cfg):
    d = cfg.get("defaults") or {}
    return {
        "stale_days": _as_int(d.get("stale_days"), DEFAULT_STALE_DAYS),
        "work_item_types": d.get("work_item_types") or list(DEFAULT_WORK_ITEM_TYPES),
        "digest_day": d.get("digest_day") or "monday",
    }


def iter_clients(cfg, only_key=None):
    """Yield enabled client blocks (optionally just one by key), defaults merged in."""
    defs = client_defaults(cfg)
    for c in cfg.get("clients") or []:
        if not isinstance(c, dict):
            continue
        if only_key and c.get("key") != only_key:
            continue
        if not only_key and not _truthy(c.get("enabled", True)):
            continue
        merged = dict(c)
        merged.setdefault("stale_days", defs["stale_days"])
        merged.setdefault("work_item_types", defs["work_item_types"])
        merged.setdefault("open_states_exclude", [])
        merged.setdefault("stale_states_exclude", [])
        merged.setdefault("teams", [])
        merged.setdefault("people", [])
        yield merged


def _as_int(v, default):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _truthy(v):
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "yes", "on")


# --- Auth / token minting ----------------------------------------------------

def _env_pat_name(key):
    return "ADO_PAT_" + "".join(ch if ch.isalnum() else "_" for ch in str(key)).upper()


def mint_azcli_token(tenant_id=None):
    """Mint a 1-hour Entra bearer token for Azure DevOps via the az CLI. Requires an
    active `az login` (interactive user or service principal) in the target tenant."""
    if not _which("az"):
        raise AdoError("az CLI not found on PATH — needed for azcli/sp auth")
    cmd = ["az", "account", "get-access-token", "--resource", ADO_RESOURCE,
           "--query", "accessToken", "-o", "tsv"]
    if tenant_id:
        cmd += ["--tenant", str(tenant_id)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        raise AdoError("az token mint failed: %s" % exc)
    if out.returncode != 0:
        # az writes the real reason to stderr; it can mention tenant/login but never
        # a secret, so it's safe to surface (trimmed).
        raise AdoError("az token mint failed (rc=%d): %s"
                       % (out.returncode, (out.stderr or "").strip()[:400]))
    token = (out.stdout or "").strip()
    if not token:
        raise AdoError("az returned an empty access token")
    return token


def auth_header(client):
    """Return the Authorization header value for a client per its `auth` mode.
    Never logs or returns the raw secret to anything but the header string."""
    mode = (client.get("auth") or "azcli").strip().lower()
    if mode in ("azcli", "sp"):
        # sp == "az login --service-principal was done by the operator"; token minting
        # is identical to the interactive case.
        token = mint_azcli_token(client.get("tenant_id"))
        return "Bearer " + token
    if mode == "pat":
        env = _env_pat_name(client.get("key"))
        pat = os.environ.get(env)
        if not pat:
            raise AdoError(
                "auth=pat but env %s is not set (scope: vso.work). Export it first."
                % env)
        basic = base64.b64encode((":" + pat).encode("utf-8")).decode("ascii")
        return "Basic " + basic
    raise AdoError("unknown auth mode %r (use azcli | pat | sp)" % mode)


# --- REST client -------------------------------------------------------------

class AdoClient:
    """Thin Azure DevOps REST client for one client org/project.

    Auth is resolved once (token/PAT) and reused. All requests redact the
    Authorization header from any error/debug output.
    """

    def __init__(self, org, project=None, authorization=None, verbose=False):
        self.org = org.rstrip("/")
        self.project = project
        self._auth = authorization
        self.verbose = verbose
        self._ctx = ssl.create_default_context()

    # -- low-level ------------------------------------------------------------

    def _request(self, method, url, body=None, base=None, retries=4):
        full = url if url.startswith("http") else (base or self.org) + url
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self._auth:
            headers["Authorization"] = self._auth
        if self.verbose:
            _log("%s %s" % (method, _redact_url(full)))
        attempt = 0
        while True:
            attempt += 1
            req = urllib.request.Request(full, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, context=self._ctx, timeout=90) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as exc:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                if exc.code in (429, 500, 502, 503, 504) and attempt <= retries:
                    _sleep_backoff(attempt, retry_after)
                    continue
                detail = _safe_error_body(exc)
                raise AdoError("HTTP %d for %s: %s"
                               % (exc.code, _redact_url(full), detail))
            except urllib.error.URLError as exc:
                if attempt <= retries:
                    _sleep_backoff(attempt, None)
                    continue
                raise AdoError("network error for %s: %s"
                               % (_redact_url(full), exc.reason))

    def _get(self, url, base=None):
        return self._request("GET", url, base=base)

    def _post(self, url, body, base=None):
        return self._request("POST", url, body=body, base=base)

    # -- work item queries ----------------------------------------------------

    def wiql_ids(self, query, project=None, top=WIQL_TOP):
        """Run a WIQL query (project-scoped) and return the ordered list of ids."""
        proj = project or self.project
        if not proj:
            raise AdoError("wiql_ids needs a project")
        url = "/%s/_apis/wit/wiql?api-version=%s&$top=%d" % (
            _seg(proj), API_VERSION, int(top))
        res = self._post(url, {"query": query})
        items = res.get("workItems") or []
        if len(items) >= top:
            _log("! WIQL hit the $top cap (%d) — results may be truncated" % top)
        return [it["id"] for it in items if "id" in it]

    def work_items(self, ids, fields=None):
        """Batch-fetch fields for ids (auto-chunked to the 200/call API cap)."""
        fields = fields or DIGEST_FIELDS
        out = []
        for chunk in _chunks(ids, WORKITEMS_BATCH_MAX):
            if not chunk:
                continue
            res = self._post(
                "/_apis/wit/workitemsbatch?api-version=%s" % API_VERSION,
                {"ids": list(chunk), "fields": fields})
            out.extend(res.get("value") or [])
        return out

    # -- metadata / discovery -------------------------------------------------

    def team_field_values(self, project, team):
        """Area-path scope for a team. Returns [(area_path, include_children), ...]."""
        url = "/%s/%s/_apis/work/teamsettings/teamfieldvalues?api-version=%s" % (
            _seg(project), _seg(team), API_VERSION)
        res = self._get(url)
        vals = res.get("values") or []
        out = []
        for v in vals:
            path = v.get("value")
            if path:
                out.append((path, bool(v.get("includeChildren", True))))
        return out

    def work_item_type_states(self, project, wtype):
        """States for a work item type, each with its category
        (Proposed / InProgress / Resolved / Completed / Removed)."""
        url = "/%s/_apis/wit/workitemtypes/%s/states?api-version=%s" % (
            _seg(project), _seg(wtype), API_VERSION)
        res = self._get(url)
        return [{"name": s.get("name"), "category": s.get("category")}
                for s in (res.get("value") or [])]

    def list_projects(self):
        res = self._get("/_apis/projects?api-version=%s&$top=1000" % API_VERSION)
        return [{"name": p.get("name"), "id": p.get("id")}
                for p in (res.get("value") or [])]

    def list_teams(self, project):
        url = "/_apis/projects/%s/teams?api-version=%s" % (_seg(project), API_VERSION)
        res = self._get(url)
        return [{"name": t.get("name"), "id": t.get("id")}
                for t in (res.get("value") or [])]

    def profile_me(self):
        return self._get(
            "/_apis/profile/profiles/me?api-version=%s" % API_VERSION, base=VSSPS_BASE)

    def list_accounts(self, member_id):
        url = "/_apis/accounts?memberId=%s&api-version=%s" % (
            urllib.parse.quote(member_id), API_VERSION)
        res = self._get(url, base=VSSPS_BASE)
        return res.get("value") or []


def client_for(client_cfg, verbose=False):
    """Construct an AdoClient for a config block (mints the token/PAT once)."""
    org = client_cfg.get("org")
    if not org:
        raise AdoError("client %r has no org url" % client_cfg.get("key"))
    return AdoClient(org, project=client_cfg.get("project"),
                     authorization=auth_header(client_cfg), verbose=verbose)


# --- WIQL builders -----------------------------------------------------------

def wiql_quote(s):
    """Escape a value for a single-quoted WIQL string literal."""
    return "'" + str(s).replace("'", "''") + "'"


def _area_clause(area_paths):
    """OR-of-UNDER (or =) over the resolved team area paths. Empty -> no clause."""
    parts = []
    for path, include_children in area_paths:
        op = "UNDER" if include_children else "="
        parts.append("[System.AreaPath] %s %s" % (op, wiql_quote(path)))
    if not parts:
        return ""
    return "(" + " OR ".join(parts) + ")"


def _states_not_in(states):
    if not states:
        return ""
    joined = ", ".join(wiql_quote(s) for s in states)
    return "[System.State] NOT IN (%s)" % joined


def _base_clauses(project, wtype, area_paths, open_states_exclude):
    clauses = [
        "[System.TeamProject] = %s" % wiql_quote(project),
        "[System.WorkItemType] = %s" % wiql_quote(wtype),
    ]
    area = _area_clause(area_paths)
    if area:
        clauses.append(area)
    excl = _states_not_in(open_states_exclude)
    if excl:
        clauses.append(excl)
    return clauses


def _assemble(clauses):
    return ("SELECT [System.Id] FROM WorkItems WHERE "
            + " AND ".join(clauses)
            + " ORDER BY [System.ChangedDate] ASC")


def wiql_open(project, wtype, area_paths, open_states_exclude):
    """All open (non-excluded-state) items of a type in the area scope."""
    return _assemble(_base_clauses(project, wtype, area_paths, open_states_exclude))


def wiql_stale(project, wtype, area_paths, open_states_exclude,
               stale_days, stale_states_exclude):
    """Open + ASSIGNED + not changed within `stale_days` + not in a late-pipeline
    state we deliberately don't count as stale."""
    clauses = _base_clauses(project, wtype, area_paths, open_states_exclude)
    clauses.append("[System.AssignedTo] <> ''")
    clauses.append("[System.ChangedDate] < @Today - %d" % int(stale_days))
    extra = _states_not_in(stale_states_exclude)
    if extra:
        clauses.append(extra)
    return _assemble(clauses)


def wiql_unassigned(project, wtype, area_paths, open_states_exclude):
    """Open + no assignee (any age)."""
    clauses = _base_clauses(project, wtype, area_paths, open_states_exclude)
    clauses.append("[System.AssignedTo] = ''")
    return _assemble(clauses)


def wiql_recent_assignees(project, wtype, area_paths, days):
    """Items of a type changed within `days` — used by onboarding to discover the
    distinct assignees actually active in the area."""
    clauses = _base_clauses(project, wtype, area_paths, [])
    clauses.append("[System.ChangedDate] >= @Today - %d" % int(days))
    return _assemble(clauses)


def resolve_area_paths(client_cfg, ado):
    """Resolve the configured teams to (area_path, include_children) tuples. No
    teams configured -> [] (whole project, no area clause)."""
    teams = client_cfg.get("teams") or []
    project = client_cfg.get("project")
    out = []
    seen = set()
    for team in teams:
        for path, inc in ado.team_field_values(project, team):
            key = (path, inc)
            if key not in seen:
                seen.add(key)
                out.append(key)
    return out


# --- Identity mapping --------------------------------------------------------

class IdentityIndex:
    """Maps an org's raw ADO display names to the single human behind them, and
    knows which identity is the ACTIVE (primary) one for this org.

    A person block:
      name, email, ado_identities: [display names], primary: <display name>,
      assign_to: <UPN for --assigned-to on creates>
    """

    def __init__(self, people):
        self.people = people or []
        self._by_identity = {}
        for p in self.people:
            for ident in (p.get("ado_identities") or []):
                self._by_identity[_norm(ident)] = p

    def lookup(self, display_name):
        """Return (person_or_None, is_primary). is_primary is True when the item's
        assignee IS this person's active identity; False for a known-but-inactive
        (e.g. `Ext-` duplicate) identity; None when the person is unknown."""
        if not display_name:
            return (None, None)
        person = self._by_identity.get(_norm(display_name))
        if person is None:
            return (None, None)
        primary = person.get("primary")
        is_primary = (primary is None) or (_norm(display_name) == _norm(primary))
        return (person, is_primary)

    def group_name(self, display_name):
        person, _ = self.lookup(display_name)
        return person["name"] if person and person.get("name") else display_name

    def my_identities(self):
        """All display names across all people — used to answer "my work items"
        across an org's duplicate identities. (In practice the caller filters to the
        current user; onboarding supplies the full set.)"""
        names = []
        for p in self.people:
            names.extend(p.get("ado_identities") or [])
        return names


def assignee_display(fields):
    """Extract the assignee display name from a work item's fields dict, or ''."""
    a = fields.get("System.AssignedTo")
    if isinstance(a, dict):
        return a.get("displayName") or a.get("uniqueName") or ""
    if isinstance(a, str):
        return a
    return ""


def assignee_unique(fields):
    a = fields.get("System.AssignedTo")
    if isinstance(a, dict):
        return a.get("uniqueName") or ""
    return ""


def _norm(s):
    return str(s or "").strip().lower()


# --- Work item links ---------------------------------------------------------

def work_item_url(org, project, wid):
    return "%s/%s/_workitems/edit/%s" % (org.rstrip("/"),
                                         urllib.parse.quote(str(project)), wid)


# --- Redaction / logging -----------------------------------------------------

def _redact_url(url):
    """Strip any credential-shaped material from a url before logging: both userinfo
    (user:pass@host) in the netloc and token-shaped query params. Our urls never carry
    credentials, but this is the only thing logged/surfaced for every REST call."""
    try:
        parts = urllib.parse.urlsplit(url)
        # Drop any user:pass@ userinfo — keep only host[:port].
        netloc = parts.hostname or parts.netloc
        if parts.hostname and parts.port:
            netloc = "%s:%d" % (parts.hostname, parts.port)
        if not parts.query:
            return urllib.parse.urlunsplit(
                (parts.scheme, netloc, parts.path, "", parts.fragment))
        q = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        red = [(k, ("<redacted>" if k.lower() in ("token", "access_token", "sig", "pat")
                    else v)) for k, v in q]
        return urllib.parse.urlunsplit(
            (parts.scheme, netloc, parts.path,
             urllib.parse.urlencode(red), parts.fragment))
    except Exception:
        return url


def _safe_error_body(exc):
    try:
        body = exc.read().decode("utf-8", "replace")
    except Exception:
        return exc.reason if hasattr(exc, "reason") else str(exc)
    # ADO error bodies are JSON with a "message"; surface just that, capped.
    try:
        j = json.loads(body)
        msg = j.get("message") or body
    except Exception:
        msg = body
    return str(msg)[:500]


def _log(msg):
    sys.stderr.write(str(msg).rstrip() + "\n")
    sys.stderr.flush()


def _sleep_backoff(attempt, retry_after):
    if retry_after:
        try:
            time.sleep(min(float(retry_after), 30.0))
            return
        except (TypeError, ValueError):
            pass
    time.sleep(min(2.0 ** (attempt - 1), 16.0))


def _chunks(seq, n):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _seg(s):
    """URL-encode one path segment (keeps things like spaces in a project name safe)."""
    return urllib.parse.quote(str(s), safe="")


def _which(name):
    from shutil import which
    return which(name)
