#!/usr/bin/env python3
"""ado-onboard — guided, read-only setup for a new Azure DevOps client.

New-client setup is discovery-driven, not hand-authored YAML. This tool:

  1. Verifies auth (Entra via az login, or a PAT) against the VSSPS profile endpoint.
  2. Discovers the orgs you can see -> project -> team(s), and resolves each team's
     area paths.
  3. Fetches states per work item type and proposes:
       open_states_exclude  = Completed + Removed category states
       stale_states_exclude = Resolved category states
  4. Discovers the people actually active in the area (distinct System.AssignedTo over
     the last ~180 days), groups duplicate `Ext-`/member identities by fuzzy match, and
     for each person captures which identity is PRIMARY (varies per client), the
     assign_to UPN, and the digest email.
  5. Prompts for recipients + cadence.
  6. Emits a ready-to-paste client block. It is READ-ONLY by default (prints the block);
     only `--write` appends it to ~/.coop/devops/clients.yml, and it refuses to
     duplicate an existing key. `--check` compares discovery against an existing block.

Interactive pickers are used when a TTY is present and a value wasn't supplied by a
flag; everything is also fully flag-drivable so the agent (or a re-run) can operate it
non-interactively. Nothing here mutates Azure DevOps.

Usage:
  ado-onboard.py --key KEY [--org URL] [--project NAME] [--team NAME ...]
                 [--auth azcli|pat] [--tenant ID]
                 [--work-item-type "User Story" --work-item-type Feature]
                 [--stale-days N] [--assignee-days 180]
                 [--write | --check] [--force] [--yes] [--no-smoke] [--verbose]
"""

import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ado_lib as A  # noqa: E402


# --- Prompt helpers ----------------------------------------------------------

def _tty():
    return sys.stdin.isatty() and sys.stdout.isatty()


def ask(prompt, default=None):
    if not _tty():
        return default
    suffix = " [%s]" % default if default not in (None, "") else ""
    try:
        val = input("%s%s: " % (prompt, suffix)).strip()
    except EOFError:
        return default
    return val or default


def ask_yes(prompt, default=True):
    if not _tty():
        return default
    d = "Y/n" if default else "y/N"
    try:
        val = input("%s [%s]: " % (prompt, d)).strip().lower()
    except EOFError:
        return default
    if not val:
        return default
    return val in ("y", "yes")


def pick(label, options, render=str, allow_multi=False, preselect=None):
    """Choose one (or several) of `options`. Non-interactive: return preselect if
    given, else the sole option, else raise for the operator to pass a flag."""
    if preselect:
        return preselect
    if not options:
        if allow_multi:
            return []
        raise A.AdoError("%s: no candidates found" % label)
    if len(options) == 1 and not allow_multi:
        return options[0]
    if not _tty():
        raise A.AdoError(
            "%s: %d candidates and no TTY — pass the value as a flag "
            "(candidates: %s)" % (label, len(options),
                                  ", ".join(render(o) for o in options[:12])))
    print("\n%s:" % label)
    for i, o in enumerate(options, 1):
        print("  %2d) %s" % (i, render(o)))
    try:
        if allow_multi:
            raw = input("  choose (comma-separated numbers, blank = none/all-project): ").strip()
            if not raw:
                return []
            idxs = [int(x) for x in raw.replace(" ", "").split(",") if x.isdigit()]
            return [options[i - 1] for i in idxs if 1 <= i <= len(options)]
        while True:
            raw = input("  choose 1-%d: " % len(options)).strip()
            if raw.isdigit() and 1 <= int(raw) <= len(options):
                return options[int(raw) - 1]
    except EOFError:
        raise A.AdoError("%s: input closed before a choice was made" % label)


# --- Identity discovery ------------------------------------------------------

def _ident_key(display, unique):
    """Normalize an identity for duplicate grouping: strip an `Ext-`/`Ext ` prefix
    and lowercase the display name; also expose the uniqueName local part."""
    d = str(display or "").strip()
    low = d.lower()
    for pre in ("ext-", "ext ", "ext:"):
        if low.startswith(pre):
            d = d[len(pre):].strip()
            break
    local = str(unique or "").split("@", 1)[0].lower().replace("ext-", "").strip()
    return (d.lower(), local)


def discover_people(ado, project, wtypes, areas, days, verbose=False):
    """Return grouped people: [{identities:[(display,unique)], counts:{display:n}}]."""
    seen = {}          # display -> {"unique":.., "count":.., "uniques": set()}
    for wt in wtypes:
        ids = ado.wiql_ids(A.wiql_recent_assignees(project, wt, areas, days))
        for w in ado.work_items(ids, fields=["System.Id", "System.AssignedTo"]):
            f = w.get("fields") or {}
            disp = A.assignee_display(f)
            if not disp:
                continue
            uniq = A.assignee_unique(f)
            rec = seen.setdefault(disp, {"unique": uniq, "count": 0, "uniques": set()})
            rec["count"] += 1
            if uniq and not rec["unique"]:
                rec["unique"] = uniq
            if uniq:
                rec["uniques"].add(uniq)

    # One display name backed by two distinct accounts likely means two DIFFERENT humans
    # (generic/guest names collide) — grouping can't tell them apart, so flag it for the
    # operator to split by hand rather than silently merging.
    for disp, rec in seen.items():
        if len(rec["uniques"]) > 1:
            _info("! display name %r maps to %d distinct accounts (%s) — verify whether "
                  "that is one person with two accounts or two different people, and split "
                  "the block if needed." % (disp, len(rec["uniques"]), ", ".join(sorted(rec["uniques"]))))

    # Group by fuzzy key (normalized display OR shared uniqueName local part).
    groups = []
    index = {}  # key-part -> group
    for disp, rec in sorted(seen.items(), key=lambda kv: -kv[1]["count"]):
        dkey, local = _ident_key(disp, rec["unique"])
        g = index.get(("d", dkey)) or (index.get(("l", local)) if local else None)
        if g is None:
            g = {"identities": [], "counts": {}}
            groups.append(g)
        g["identities"].append((disp, rec["unique"]))
        g["counts"][disp] = rec["count"]
        index[("d", dkey)] = g
        if local:
            index[("l", local)] = g
    return groups


# --- State proposal ----------------------------------------------------------

def propose_state_excludes(ado, project, wtypes, verbose=False):
    """Union states across the configured types; propose exclude lists by category.
    Returns (open_exclude, stale_exclude, all_states[(name,category)])."""
    by_name = {}
    for wt in wtypes:
        for s in ado.work_item_type_states(project, wt):
            if s["name"]:
                by_name[s["name"]] = s["category"]
    open_excl, stale_excl = [], []
    for name, cat in by_name.items():
        if cat in ("Completed", "Removed"):
            open_excl.append(name)
        elif cat == "Resolved":
            stale_excl.append(name)
    return sorted(open_excl), sorted(stale_excl), sorted(by_name.items())


# --- YAML emission (block matches config/devops.clients.example.yml style) ----

def _yv(v):
    """Render a scalar for inline YAML, quoting when needed."""
    s = "" if v is None else str(v)
    if s == "":
        return '""'
    if any(ch in s for ch in ":#[]{},&*!|>'\"%@`") or s.strip() != s:
        return '"%s"' % s.replace('"', '\\"')
    return s


def _yl(items):
    return "[" + ", ".join(_yv(x) for x in items) + "]"


def emit_client_block(spec):
    L = []
    L.append("  - key: %s" % _yv(spec["key"]))
    L.append("    enabled: true")
    L.append("    org: %s" % _yv(spec["org"]))
    L.append("    project: %s" % _yv(spec["project"]))
    L.append("    teams: %s" % _yl(spec["teams"]))
    L.append("    auth: %s" % _yv(spec["auth"]))
    if spec.get("tenant_id"):
        L.append("    tenant_id: %s" % _yv(spec["tenant_id"]))
    if spec.get("stale_days"):
        L.append("    stale_days: %d" % int(spec["stale_days"]))
    L.append("    open_states_exclude: %s" % _yl(spec["open_states_exclude"]))
    L.append("    stale_states_exclude: %s" % _yl(spec["stale_states_exclude"]))
    if not spec["people"]:
        L.append("    people: []")
    else:
        L.append("    people:")
    for p in spec["people"]:
        L.append("      - name: %s" % _yv(p["name"]))
        L.append("        email: %s" % _yv(p.get("email") or "TODO"))
        L.append("        ado_identities: %s" % _yl(p["ado_identities"]))
        L.append("        primary: %s" % _yv(p["primary"]))
        L.append("        assign_to: %s" % _yv(p.get("assign_to") or "TODO"))
    L.append("    recipients:")
    L.append("      to: %s" % _yl(spec["recipients"].get("to") or []))
    L.append("      cc: %s" % _yl(spec["recipients"].get("cc") or []))
    return "\n".join(L)


# --- Main --------------------------------------------------------------------

def build_spec(args):
    tenant = args.tenant
    auth = args.auth
    # A throwaway client purely to reach the discovery endpoints. For pat auth the
    # org is required up front (PAT is org-scoped); for azcli we can enumerate orgs.
    if auth == "pat" and not args.org:
        raise A.AdoError("--auth pat requires --org (PATs are org-scoped)")

    # Resolve org.
    if args.org:
        org = args.org.rstrip("/")
        probe = A.AdoClient(org, authorization=A.auth_header(
            {"auth": auth, "tenant_id": tenant, "key": args.key}), verbose=args.verbose)
    else:
        # Enumerate orgs via the profile/accounts endpoints (azcli only). The org url
        # here is a placeholder — profile_me/list_accounts hit VSSPS explicitly.
        probe0 = A.AdoClient("https://dev.azure.com/_discovery",
                             authorization=A.auth_header(
                                 {"auth": auth, "tenant_id": tenant, "key": args.key}),
                             verbose=args.verbose)
        me = probe0.profile_me()
        accounts = probe0.list_accounts(me.get("id"))
        if not accounts:
            raise A.AdoError("no Azure DevOps orgs visible for this identity")
        org_choice = pick("Organization", accounts,
                          render=lambda a: a.get("accountName"))
        org = "https://dev.azure.com/%s" % org_choice.get("accountName")
        probe = A.AdoClient(org, authorization=A.auth_header(
            {"auth": auth, "tenant_id": tenant, "key": args.key}), verbose=args.verbose)
    _info("org: %s" % org)

    # Project.
    if args.project:
        project = args.project
    else:
        projects = probe.list_projects()
        project = pick("Project", projects, render=lambda p: p["name"])["name"]
    probe.project = project
    _info("project: %s" % project)

    # Teams.
    if args.team:
        teams = list(args.team)
    else:
        all_teams = probe.list_teams(project)
        chosen = pick("Team(s) — blank = whole project", all_teams,
                      render=lambda t: t["name"], allow_multi=True)
        teams = [t["name"] for t in (chosen or [])]
    _info("teams: %s" % (teams or "(whole project)"))

    # Area paths.
    areas = []
    for t in teams:
        for path, inc in probe.team_field_values(project, t):
            areas.append((path, inc))
    if teams and not areas:
        _info("! no area paths resolved for the chosen team(s); scoping to whole project")

    wtypes = args.work_item_type or list(A.DEFAULT_WORK_ITEM_TYPES)

    # States.
    open_excl, stale_excl, all_states = propose_state_excludes(probe, project, wtypes)
    print("\nStates across %s:" % ", ".join(wtypes))
    for name, cat in all_states:
        print("  - %-28s (%s)" % (name, cat))
    print("Proposed open_states_exclude (Completed+Removed): %s" % (open_excl or "[]"))
    print("Proposed stale_states_exclude (Resolved):         %s" % (stale_excl or "[]"))
    if _tty() and not args.yes:
        if not ask_yes("Accept proposed state excludes?", True):
            open_excl = _csv(ask("open_states_exclude (comma-separated)",
                                 ",".join(open_excl))) or open_excl
            stale_excl = _csv(ask("stale_states_exclude (comma-separated)",
                                  ",".join(stale_excl))) or stale_excl

    # People.
    _info("discovering assignees active in the last %d days…" % args.assignee_days)
    groups = discover_people(probe, project, wtypes, areas, args.assignee_days,
                             verbose=args.verbose)
    people = []
    for g in groups:
        idents = [d for d, _u in g["identities"]]
        # Default primary = the identity with the most recent activity.
        default_primary = max(g["counts"].items(), key=lambda kv: kv[1])[0]
        default_unique = dict(g["identities"]).get(default_primary) or ""
        name = _ext_strip(default_primary)
        if _tty() and not args.yes:
            print("\nPerson: %s  (identities: %s)"
                  % (name, ", ".join("%s×%d" % (d, g["counts"][d]) for d in idents)))
            if len(idents) > 1:
                primary = pick("  Which identity is the ACTIVE (primary) one?",
                               idents) or default_primary
            else:
                primary = default_primary
            assign_to = ask("  assign_to UPN (for creates)",
                            dict(g["identities"]).get(primary) or default_unique)
            email = ask("  digest email", "TODO")
            name = ask("  display name", name)
        else:
            primary = default_primary
            assign_to = default_unique or "TODO"
            email = "TODO"
        people.append({
            "name": name,
            "email": email,
            "ado_identities": idents,
            "primary": primary,
            "assign_to": assign_to,
        })

    # Recipients + cadence.
    to = _csv(ask("Digest recipients — to (comma-separated)", "")) or []
    cc = _csv(ask("Digest recipients — cc (comma-separated)", "")) or []
    stale_days = args.stale_days

    return {
        "key": args.key,
        "org": org,
        "project": project,
        "teams": teams,
        "auth": auth,
        "tenant_id": tenant,
        "stale_days": stale_days,
        "open_states_exclude": open_excl,
        "stale_states_exclude": stale_excl,
        "people": people,
        "recipients": {"to": to, "cc": cc},
    }


def _csv(s):
    if not s:
        return []
    return [x.strip() for x in str(s).split(",") if x.strip()]


def _ext_strip(name):
    n = str(name)
    for pre in ("Ext-", "Ext ", "ext-"):
        if n.startswith(pre):
            return n[len(pre):].strip()
    return n


def existing_client(cfg, key=None, org=None, project=None):
    for c in cfg.get("clients") or []:
        if not isinstance(c, dict):
            continue
        if key and c.get("key") == key:
            return c
        if org and project and str(c.get("org") or "").rstrip("/") == str(org).rstrip("/") \
                and c.get("project") == project:
            return c
    return None


def append_block(cfg_path, block):
    """Append a client block, adding the top-level `clients:` header only when the file
    has no such key yet — keyed on the KEY's presence, not the file's, so a config that
    already holds only defaults:/sender: doesn't get a dangling, parser-losing list."""
    import re
    existing = ""
    if os.path.isfile(cfg_path):
        with open(cfg_path, encoding="utf-8") as f:
            existing = f.read()
    has_clients_key = bool(re.search(r"(?m)^clients[ \t]*:", existing))
    out = existing
    if out and not out.endswith("\n"):
        out += "\n"
    if not has_clients_key:
        out += "clients:\n"
    out += "\n" + block.rstrip() + "\n"
    with open(cfg_path, "w", encoding="utf-8") as f:
        f.write(out)


def run_smoke(cfg_path, key):
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ado-digest.py")
    _info("\n--- smoke test: ado-digest --no-state --client %s (dry run, no email) ---" % key)
    env = dict(os.environ, COOP_DEVOPS_CONFIG=cfg_path)
    py = sys.executable or "python3"
    subprocess.run([py, script, "--client", key, "--no-state", "--format", "md"], env=env)


def main(argv):
    ap = argparse.ArgumentParser(prog="ado-onboard",
                                 description="Guided, read-only Azure DevOps client onboarding.")
    ap.add_argument("--key", required=True, help="short client key (env-var/state-file safe)")
    ap.add_argument("--org", help="org url, e.g. https://dev.azure.com/Name")
    ap.add_argument("--project", help="project name")
    ap.add_argument("--team", action="append", help="team name (repeatable)")
    ap.add_argument("--auth", choices=("azcli", "pat", "sp"), default="azcli")
    ap.add_argument("--tenant", help="tenant id (azcli/sp)")
    ap.add_argument("--work-item-type", action="append", help="repeatable; default User Story + Feature")
    ap.add_argument("--stale-days", type=int, help="override stale threshold for this client")
    ap.add_argument("--assignee-days", type=int, default=180, help="assignee discovery window")
    ap.add_argument("--config", help="config path (default resolved like ado-digest)")
    ap.add_argument("--write", action="store_true", help="append the block to the config")
    ap.add_argument("--check", action="store_true", help="compare discovery to an existing block; never writes")
    ap.add_argument("--force", action="store_true", help="allow --write even if the key exists")
    ap.add_argument("--yes", action="store_true", help="accept proposed defaults (non-interactive)")
    ap.add_argument("--no-smoke", action="store_true", help="skip the post-write digest smoke test")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    cfg_path = A.config_path(args.config)
    cfg = {}
    if os.path.isfile(cfg_path):
        try:
            cfg = A.load_config(cfg_path)
        except A.AdoError as exc:
            _err("warning: %s" % exc)

    try:
        spec = build_spec(args)
    except A.AdoError as exc:
        _err(str(exc))
        return 2

    block = emit_client_block(spec)
    print("\n# ---- proposed client block for %s ----" % cfg_path)
    print(block)
    print("# ---- end block ----")

    prior = existing_client(cfg, key=spec["key"], org=spec["org"], project=spec["project"])

    if args.check:
        if prior:
            _compare(prior, spec)
        else:
            _info("no existing client matches key/org/project — this would be a new block.")
        return 0

    if args.write:
        if prior and not args.force:
            _err("a client with key %r (or same org/project) already exists — refusing to "
                 "duplicate. Re-run with --check to compare, or --force to append anyway."
                 % spec["key"])
            return 1
        if not os.path.isfile(cfg_path):
            parent = os.path.dirname(cfg_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
        append_block(cfg_path, block)
        _info("appended client %r to %s" % (spec["key"], cfg_path))
        if not args.no_smoke:
            run_smoke(cfg_path, spec["key"])
    else:
        _info("dry run — nothing written. Re-run with --write to append (or --check to compare).")
    return 0


def _compare(prior, spec):
    _info("comparing discovery against existing client %r:" % prior.get("key"))
    def norm(v):
        return sorted(v) if isinstance(v, list) else v
    checks = [
        ("org", str(prior.get("org") or "").rstrip("/"), spec["org"].rstrip("/")),
        ("project", prior.get("project"), spec["project"]),
        ("teams", norm(prior.get("teams") or []), norm(spec["teams"])),
        ("open_states_exclude", norm(prior.get("open_states_exclude") or []), norm(spec["open_states_exclude"])),
    ]
    for label, a, b in checks:
        mark = "✓" if a == b else "≠"
        _info("  %s %-22s discovered=%s existing=%s" % (mark, label, b, a))
    prior_idents = set()
    for p in prior.get("people") or []:
        prior_idents.update(p.get("ado_identities") or [])
    disc_idents = set()
    for p in spec["people"]:
        disc_idents.update(p["ado_identities"])
    only_disc = disc_idents - prior_idents
    only_prior = prior_idents - disc_idents
    _info("  identities: %d discovered, %d in config; new=%s missing=%s"
          % (len(disc_idents), len(prior_idents), sorted(only_disc) or "-", sorted(only_prior) or "-"))
    _info("  (operator overrides like extra stale_states_exclude or chosen primaries are "
          "preserved in the existing block — this check only verifies discovered facts.)")


def _err(msg):
    sys.stderr.write(str(msg).rstrip() + "\n")


def _info(msg):
    sys.stderr.write(str(msg).rstrip() + "\n")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
