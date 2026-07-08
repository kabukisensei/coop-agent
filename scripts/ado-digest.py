#!/usr/bin/env python3
"""ado-digest — Azure DevOps boards watchdog digest for coop.

Read-only against Azure DevOps. For each enabled client in ~/.coop/devops/clients.yml
it runs three WIQL queries per configured work item type — open / stale / unassigned —
batch-fetches the fields, and renders one digest per client:

  * a summary strip (open / stale / unassigned per type, with deltas vs the last run)
  * stale items grouped by assignee (duplicate `Ext-`/member identities merged to one
    person), oldest first, each linking to the work item, with NEW-since-last-run and
    "assigned to inactive account" flags
  * the unassigned backlog, oldest first

Output modes: --format md|html, and --send (Microsoft Graph email per client).
Default is a dry run: it prints and sends nothing.

Confidentiality: every client identifier comes from the private config at runtime;
none is baked into this file. The digest OUTPUT contains client data and must never
be written into a repo — it goes to stdout / email / the local state dir only.

Usage:
  ado-digest.py [--config PATH] [--client KEY] [--format md|html]
                [--send] [--dry-run] [--stale-days N] [--rollup]
                [--no-state] [--verbose]

Exit code: 0 if every client succeeded, non-zero if any client failed (the rest
still run; failures are summarized at the end).
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ado_lib as A  # noqa: E402


# --- Model building ----------------------------------------------------------

def _parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def _days_since(iso, now):
    dt = _parse_dt(iso)
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return max(0, (now - dt).days)


def _row(fields, org, project, now):
    wid = fields.get("System.Id")
    return {
        "id": wid,
        "title": fields.get("System.Title") or "(no title)",
        "type": fields.get("System.WorkItemType") or "",
        "state": fields.get("System.State") or "",
        "assignee": A.assignee_display(fields),
        "changed": fields.get("System.ChangedDate"),
        "days": _days_since(fields.get("System.ChangedDate"), now),
        "area": fields.get("System.AreaPath") or "",
        "iteration": fields.get("System.IterationPath") or "",
        "tags": fields.get("System.Tags") or "",
        "url": A.work_item_url(org, project, wid),
    }


def build_client_model(client_cfg, prev_state, stale_days, verbose=False):
    """Query one client and return a render-ready model dict. Raises AdoError on
    any auth/query failure (caller isolates the client)."""
    now = datetime.now(timezone.utc)
    ado = A.client_for(client_cfg, verbose=verbose)
    project = client_cfg["project"]
    org = client_cfg["org"]
    areas = A.resolve_area_paths(client_cfg, ado)
    idx = A.IdentityIndex(client_cfg.get("people"))
    osx = client_cfg.get("open_states_exclude") or []
    ssx = client_cfg.get("stale_states_exclude") or []

    prev_counts = (prev_state or {}).get("counts") or {}
    prev_stale = (prev_state or {}).get("stale_ids") or {}
    first_run = not prev_state          # no baseline yet -> don't paint everything 🆕

    counts = {}
    stale_by_person = {}          # person/display name -> list of rows
    unassigned_rows = []
    stale_ids_now = {}
    inactive_count = 0

    for wt in client_cfg.get("work_item_types") or []:
        open_ids = ado.wiql_ids(A.wiql_open(project, wt, areas, osx))
        stale_ids = ado.wiql_ids(
            A.wiql_stale(project, wt, areas, osx, stale_days, ssx))
        unassigned_ids = ado.wiql_ids(A.wiql_unassigned(project, wt, areas, osx))

        counts[wt] = {
            "open": len(open_ids),
            "stale": len(stale_ids),
            "unassigned": len(unassigned_ids),
        }
        stale_ids_now[wt] = list(stale_ids)
        prev_stale_set = set(prev_stale.get(wt) or [])

        # Only stale + unassigned need field detail (open is a count only).
        detail_ids = list(dict.fromkeys(list(stale_ids) + list(unassigned_ids)))
        by_id = {w.get("id"): (w.get("fields") or {})
                 for w in ado.work_items(detail_ids)}

        for wid in stale_ids:
            row = _row({**by_id.get(wid, {}), "System.Id": wid}, org, project, now)
            person, is_primary = idx.lookup(row["assignee"])
            row["is_primary"] = is_primary
            row["inactive"] = (is_primary is False)
            row["newly_stale"] = (not first_run) and (wid not in prev_stale_set)
            if row["inactive"]:
                inactive_count += 1
            group = idx.group_name(row["assignee"]) or "(unknown)"
            stale_by_person.setdefault(group, []).append(row)

        for wid in unassigned_ids:
            unassigned_rows.append(
                _row({**by_id.get(wid, {}), "System.Id": wid}, org, project, now))

    # Oldest first within every group / list (fewer "days" is fresher, so ascending
    # by changed date == descending by days -> sort by days desc puts oldest first).
    for rows in stale_by_person.values():
        rows.sort(key=lambda r: (r["days"] is None, -(r["days"] or 0)))
    unassigned_rows.sort(key=lambda r: (r["days"] is None, -(r["days"] or 0)))
    # Groups ordered by size (biggest offender first), unknown group last.
    ordered_groups = sorted(
        stale_by_person.items(),
        key=lambda kv: (kv[0] == "(unknown)", -len(kv[1]), kv[0].lower()))

    # Deltas vs previous run.
    for wt, cur in counts.items():
        prev = prev_counts.get(wt) or {}
        cur["delta"] = {k: (cur[k] - prev.get(k, cur[k])) if wt in prev_counts else None
                        for k in ("open", "stale", "unassigned")}

    display = client_cfg.get("name") or project or client_cfg.get("key")
    return {
        "key": client_cfg.get("key"),
        "display": display,
        "generated": now,
        "stale_days": stale_days,
        "counts": counts,
        "stale_groups": ordered_groups,
        "unassigned": unassigned_rows,
        "inactive_count": inactive_count,
        "recipients": client_cfg.get("recipients") or {},
        "state": {
            "updated": now.isoformat(),
            "counts": {wt: {k: counts[wt][k] for k in ("open", "stale", "unassigned")}
                       for wt in counts},
            "stale_ids": stale_ids_now,
        },
    }


# --- Rendering: Markdown -----------------------------------------------------

def _fmt_delta(d):
    if d is None:
        return ""
    if d == 0:
        return " (±0)"
    return " (%+d)" % d


def render_md(m):
    L = []
    when = m["generated"].strftime("%Y-%m-%d %H:%M UTC")
    L.append("# Azure DevOps digest — %s" % m["display"])
    L.append("")
    L.append("_Generated %s · stale threshold %d days_" % (when, m["stale_days"]))
    L.append("")
    L.append("## Summary")
    L.append("")
    L.append("| Type | Open | Stale (>%dd) | Unassigned |" % m["stale_days"])
    L.append("|------|-----:|-------------:|-----------:|")
    tot = {"open": 0, "stale": 0, "unassigned": 0}
    for wt, c in m["counts"].items():
        for k in tot:
            tot[k] += c[k]
        L.append("| %s | %d%s | %d%s | %d%s |" % (
            wt,
            c["open"], _fmt_delta(c["delta"]["open"]),
            c["stale"], _fmt_delta(c["delta"]["stale"]),
            c["unassigned"], _fmt_delta(c["delta"]["unassigned"])))
    if len(m["counts"]) > 1:
        L.append("| **Total** | **%d** | **%d** | **%d** |"
                 % (tot["open"], tot["stale"], tot["unassigned"]))
    L.append("")

    n_stale = sum(len(rows) for _, rows in m["stale_groups"])
    L.append("## Stale — assigned & untouched >%dd (%d)" % (m["stale_days"], n_stale))
    L.append("")
    if not n_stale:
        L.append("_None — every assigned item was touched within the window._")
    for group, rows in m["stale_groups"]:
        L.append("### %s (%d)" % (group, len(rows)))
        for r in rows:
            L.append("- " + _md_row(r))
        L.append("")
    if m["inactive_count"]:
        L.append("> ⚠ %d item(s) are assigned to an **inactive account** — invisible "
                 "to that person's own queries/notifications; reassign to their active "
                 "identity." % m["inactive_count"])
        L.append("")

    L.append("## Unassigned — open, no assignee (%d)" % len(m["unassigned"]))
    L.append("")
    if not m["unassigned"]:
        L.append("_None — every open item has an assignee._")
    for r in m["unassigned"]:
        L.append("- " + _md_row(r, show_assignee=False))
    L.append("")
    L.append("---")
    L.append("_🆕 = newly stale since the last run. \"Stale\" means untouched: "
             "`System.ChangedDate` bumps on any edit including comments, so a stale "
             "item has had no activity at all — not merely no state change._")
    return "\n".join(L).rstrip() + "\n"


def _md_row(r, show_assignee=True):
    bits = ["[#%s](%s)" % (r["id"], r["url"]), "**%s**" % _clean(r["title"])]
    meta = [r["type"], r["state"]]
    if show_assignee and r.get("assignee"):
        meta.append(r["assignee"])
    if r["days"] is not None:
        meta.append("%dd" % r["days"])
    line = " — ".join([" ".join(bits[:1]) + " " + bits[1], " · ".join(m for m in meta if m)])
    if r.get("newly_stale"):
        line += " 🆕"
    if r.get("inactive"):
        line += " ⚠ inactive account"
    return line


# --- Rendering: HTML (Outlook-safe, table-based) -----------------------------

def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _clean(s):
    # Titles can contain markdown-significant chars; keep them readable in md.
    return str(s).replace("|", "\\|").replace("\n", " ").strip()


def render_html(m):
    when = m["generated"].strftime("%Y-%m-%d %H:%M UTC")
    css_td = 'style="padding:4px 8px;border:1px solid #d0d7de;font-family:Segoe UI,Arial,sans-serif;font-size:13px"'
    css_th = 'style="padding:4px 8px;border:1px solid #d0d7de;background:#00416b;color:#fff;font-family:Segoe UI,Arial,sans-serif;font-size:13px;text-align:left"'
    H = ['<div style="font-family:Segoe UI,Arial,sans-serif;color:#24292f">']
    H.append('<h2 style="color:#00416b;margin:0 0 4px">Azure DevOps digest — %s</h2>'
             % _esc(m["display"]))
    H.append('<div style="color:#57606a;font-size:12px;margin-bottom:12px">'
             'Generated %s · stale threshold %d days</div>'
             % (_esc(when), m["stale_days"]))

    # Summary table
    H.append('<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:16px">')
    H.append('<tr><th %s>Type</th><th %s>Open</th><th %s>Stale &gt;%dd</th><th %s>Unassigned</th></tr>'
             % (css_th, css_th, css_th, m["stale_days"], css_th))
    tot = {"open": 0, "stale": 0, "unassigned": 0}
    for wt, c in m["counts"].items():
        for k in tot:
            tot[k] += c[k]
        H.append('<tr><td %s>%s</td><td %s align="right">%d%s</td>'
                 '<td %s align="right">%d%s</td><td %s align="right">%d%s</td></tr>'
                 % (css_td, _esc(wt),
                    css_td, c["open"], _esc(_fmt_delta(c["delta"]["open"])),
                    css_td, c["stale"], _esc(_fmt_delta(c["delta"]["stale"])),
                    css_td, c["unassigned"], _esc(_fmt_delta(c["delta"]["unassigned"]))))
    if len(m["counts"]) > 1:
        H.append('<tr><td %s><b>Total</b></td><td %s align="right"><b>%d</b></td>'
                 '<td %s align="right"><b>%d</b></td><td %s align="right"><b>%d</b></td></tr>'
                 % (css_td, css_td, tot["open"], css_td, tot["stale"], css_td, tot["unassigned"]))
    H.append('</table>')

    n_stale = sum(len(rows) for _, rows in m["stale_groups"])
    H.append('<h3 style="color:#00416b">Stale — assigned &amp; untouched &gt;%dd (%d)</h3>'
             % (m["stale_days"], n_stale))
    if not n_stale:
        H.append('<p style="color:#57606a">None — every assigned item was touched within the window.</p>')
    for group, rows in m["stale_groups"]:
        H.append('<p style="margin:10px 0 2px"><b>%s</b> (%d)</p><ul style="margin:2px 0">'
                 % (_esc(group), len(rows)))
        for r in rows:
            H.append("<li>%s</li>" % _html_row(r))
        H.append("</ul>")
    if m["inactive_count"]:
        H.append('<p style="color:#b26a00">⚠ %d item(s) are assigned to an <b>inactive account</b> '
                 '— invisible to that person\'s own queries; reassign to their active identity.</p>'
                 % m["inactive_count"])

    H.append('<h3 style="color:#00416b">Unassigned — open, no assignee (%d)</h3>'
             % len(m["unassigned"]))
    if not m["unassigned"]:
        H.append('<p style="color:#57606a">None — every open item has an assignee.</p>')
    else:
        H.append('<ul style="margin:2px 0">')
        for r in m["unassigned"]:
            H.append("<li>%s</li>" % _html_row(r, show_assignee=False))
        H.append("</ul>")

    H.append('<hr style="border:none;border-top:1px solid #d0d7de;margin:16px 0">')
    H.append('<div style="color:#57606a;font-size:12px">🆕 = newly stale since the last run. '
             '&quot;Stale&quot; means untouched (System.ChangedDate bumps on any edit including comments).</div>')
    H.append('</div>')
    return "".join(H)


def _html_row(r, show_assignee=True):
    meta = [r["type"], r["state"]]
    if show_assignee and r.get("assignee"):
        meta.append(r["assignee"])
    if r["days"] is not None:
        meta.append("%dd" % r["days"])
    s = ('<a href="%s">#%s</a> <b>%s</b> — %s'
         % (_esc(r["url"]), r["id"], _esc(r["title"]),
            _esc(" · ".join(x for x in meta if x))))
    if r.get("newly_stale"):
        s += ' <span style="color:#1a7f37">🆕</span>'
    if r.get("inactive"):
        s += ' <span style="color:#b26a00">⚠ inactive account</span>'
    return s


# --- Rollup (internal all-clients summary) -----------------------------------

def render_rollup(models, fmt="md"):
    if fmt == "html":
        css_td = 'style="padding:4px 8px;border:1px solid #d0d7de;font-family:Segoe UI,Arial,sans-serif;font-size:13px"'
        css_th = 'style="padding:4px 8px;border:1px solid #d0d7de;background:#00416b;color:#fff;font-family:Segoe UI,Arial,sans-serif;font-size:13px;text-align:left"'
        H = ['<div style="font-family:Segoe UI,Arial,sans-serif"><h2 style="color:#00416b">Azure DevOps — internal rollup</h2>']
        H.append('<table cellspacing="0" cellpadding="0" style="border-collapse:collapse">')
        H.append('<tr><th %s>Client</th><th %s>Open</th><th %s>Stale</th><th %s>Unassigned</th></tr>'
                 % (css_th, css_th, css_th, css_th))
        for m in models:
            t = _totals(m)
            H.append('<tr><td %s>%s</td><td %s align="right">%d</td><td %s align="right">%d</td><td %s align="right">%d</td></tr>'
                     % (css_td, _esc(m["display"]), css_td, t["open"], css_td, t["stale"], css_td, t["unassigned"]))
        H.append('</table></div>')
        return "".join(H)
    L = ["# Azure DevOps — internal rollup", "",
         "| Client | Open | Stale | Unassigned |", "|--------|-----:|------:|-----------:|"]
    for m in models:
        t = _totals(m)
        L.append("| %s | %d | %d | %d |" % (m["display"], t["open"], t["stale"], t["unassigned"]))
    return "\n".join(L) + "\n"


def _totals(m):
    t = {"open": 0, "stale": 0, "unassigned": 0}
    for c in m["counts"].values():
        for k in t:
            t[k] += c[k]
    return t


# --- Microsoft Graph mailer --------------------------------------------------

class GraphMailer:
    """Sends HTML mail via Microsoft Graph using an app-only (client credentials)
    token. The client secret is read from $COOP_GRAPH_CLIENT_SECRET and never logged."""

    def __init__(self, sender):
        self.mailbox = (sender or {}).get("mailbox")
        self.tenant = (sender or {}).get("tenant_id")
        self.client_id = (sender or {}).get("client_id")
        self.secret = os.environ.get("COOP_GRAPH_CLIENT_SECRET")
        self._token = None

    def validate(self):
        missing = [k for k, v in (("sender.mailbox", self.mailbox),
                                  ("sender.tenant_id", self.tenant),
                                  ("sender.client_id", self.client_id),
                                  ("$COOP_GRAPH_CLIENT_SECRET", self.secret))
                   if not v or str(v).startswith("TODO")]
        if missing:
            raise A.AdoError(
                "cannot --send: missing/placeholder " + ", ".join(missing)
                + ". Register the Cooptimize Entra app (Mail.Send, admin consent) and "
                  "export the secret. See the azure-devops skill.")

    def _get_token(self):
        if self._token:
            return self._token
        url = "https://login.microsoftonline.com/%s/oauth2/v2.0/token" % self.tenant
        data = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.secret,
            "scope": "https://graph.microsoft.com/.default",
        }).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                tok = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            # The token endpoint echoes error/error_description (never the secret).
            raise A.AdoError("Graph token request failed: %s" % A._safe_error_body(exc))
        except urllib.error.URLError as exc:
            raise A.AdoError("Graph token request failed: %s" % exc.reason)
        self._token = tok.get("access_token")
        if not self._token:
            raise A.AdoError("Graph token response had no access_token")
        return self._token

    def send(self, subject, html, to, cc=None):
        to = to or []
        if not to:
            raise A.AdoError("no 'to' recipients configured for this client")
        msg = {
            "message": {
                "subject": subject,
                "body": {"contentType": "HTML", "content": html},
                "toRecipients": [{"emailAddress": {"address": a}} for a in to],
                "ccRecipients": [{"emailAddress": {"address": a}} for a in (cc or [])],
            },
            "saveToSentItems": True,
        }
        url = "%s/users/%s/sendMail" % (A.GRAPH_BASE, urllib.parse.quote(self.mailbox))
        req = urllib.request.Request(
            url, data=json.dumps(msg).encode("utf-8"), method="POST",
            headers={"Authorization": "Bearer " + self._get_token(),
                     "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                resp.read()
        except urllib.error.HTTPError as exc:
            raise A.AdoError("Graph sendMail failed: %s" % A._safe_error_body(exc))
        except urllib.error.URLError as exc:
            raise A.AdoError("Graph sendMail failed: %s" % exc.reason)


# --- State -------------------------------------------------------------------

def load_state(cfg_path, key):
    p = os.path.join(A.state_dir(cfg_path), "%s.json" % A.safe_key(key))
    if os.path.isfile(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}
    return {}


def save_state(cfg_path, key, state):
    d = A.state_dir(cfg_path)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "%s.json" % A.safe_key(key))
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, p)


# --- CLI ---------------------------------------------------------------------

def main(argv):
    ap = argparse.ArgumentParser(
        prog="ado-digest", description="Azure DevOps boards watchdog digest (read-only).")
    ap.add_argument("--config", help="config path (default: $COOP_DEVOPS_CONFIG or ~/.coop/devops/clients.yml)")
    ap.add_argument("--client", help="only this client key")
    ap.add_argument("--format", choices=("md", "html"), default="md")
    ap.add_argument("--send", action="store_true", help="send email via Microsoft Graph")
    ap.add_argument("--dry-run", action="store_true", help="print only, send nothing (default)")
    ap.add_argument("--stale-days", type=int, help="override the stale threshold")
    ap.add_argument("--rollup", action="store_true", help="also emit an internal all-clients rollup")
    ap.add_argument("--no-state", action="store_true", help="do not read/write state files")
    ap.add_argument("--verbose", action="store_true", help="log each REST call (headers redacted)")
    args = ap.parse_args(argv)

    try:
        cfg = A.load_config(args.config)
    except A.AdoError as exc:
        _err(str(exc))
        return 2
    cfg_path = cfg["_config_path"]

    clients = list(A.iter_clients(cfg, only_key=args.client))
    if not clients:
        _err("no enabled clients%s" % ((" matching --client %s" % args.client) if args.client else ""))
        return 2

    defs = cfg.get("defaults") or {}
    want_rollup = args.rollup or A._truthy(defs.get("internal_rollup"))

    # An explicit --dry-run always wins over --send (a preview must never deliver).
    sending = args.send and not args.dry_run

    mailer = None
    if sending:
        mailer = GraphMailer(cfg.get("sender"))
        try:
            mailer.validate()
        except A.AdoError as exc:
            _err(str(exc))
            return 2

    models, failures = [], []
    for c in clients:
        key = c.get("key") or "(no-key)"
        stale_days = args.stale_days if args.stale_days is not None else c.get("stale_days")
        prev = {} if args.no_state else load_state(cfg_path, key)
        try:
            m = build_client_model(c, prev, stale_days, verbose=args.verbose)
        except A.AdoError as exc:
            _err("[%s] %s" % (key, exc))
            failures.append((key, str(exc)))
            continue
        except Exception as exc:  # unexpected — isolate the client, keep going
            _err("[%s] unexpected error: %s" % (key, exc))
            failures.append((key, "unexpected: %s" % exc))
            continue

        body = render_html(m) if args.format == "html" else render_md(m)
        models.append(m)

        if sending:
            rec = m["recipients"]
            subject = "Azure DevOps digest — %s (%s)" % (
                m["display"], m["generated"].strftime("%Y-%m-%d"))
            html = render_html(m)  # always send HTML regardless of --format
            try:
                mailer.send(subject, html, rec.get("to"), rec.get("cc"))
                _info("[%s] sent to %s" % (key, ", ".join(rec.get("to") or [])))
            except A.AdoError as exc:
                _err("[%s] send failed: %s" % (key, exc))
                failures.append((key, "send: %s" % exc))
            else:
                # State advances ONLY on a successful send, so a dry-run preview never
                # consumes the next real digest's "newly stale" deltas.
                if not args.no_state:
                    save_state(cfg_path, key, m["state"])
        else:
            sys.stdout.write(body)
            if len(clients) > 1:
                sys.stdout.write("\n")

    if want_rollup and models:
        roll = render_rollup(models, "html" if args.format == "html" else "md")
        if sending:
            rup = defs.get("rollup") or {}
            try:
                mailer.send("Azure DevOps — internal rollup (%s)"
                            % datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                            render_rollup(models, "html"), rup.get("to"), rup.get("cc"))
                _info("[rollup] sent to %s" % ", ".join(rup.get("to") or []))
            except A.AdoError as exc:
                _err("[rollup] send failed: %s" % exc)
                failures.append(("rollup", str(exc)))
        else:
            sys.stdout.write("\n" + roll)

    if failures:
        _err("")
        _err("%d client(s) failed:" % len(failures))
        for k, why in failures:
            _err("  - %s: %s" % (k, why))
        return 1
    return 0


def _err(msg):
    sys.stderr.write(str(msg).rstrip() + "\n")


def _info(msg):
    sys.stderr.write(str(msg).rstrip() + "\n")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
