#!/usr/bin/env python3
"""Dependency-free YAML reader for coop.

coop must work on a fresh machine where the system python has no PyYAML. This
reader uses PyYAML when importable (full fidelity) and otherwise falls back to a
focused parser that handles the subset coop's .coop/project.yml uses: nested
block maps, block lists (dash at the same OR deeper indent than the key),
multi-key block-list items, inline flow lists [a, b], inline flow maps {k: v},
scalars (quoted/unquoted, with null coercion), and # comments. Block scalars
(| / >) are captured as text (not parsed as keys) but not folded; anchors,
aliases, and tags are out of scope.

Usage:
    python3 _yaml.py get  FILE dotted.key [default]   -> prints scalar (or default)
    python3 _yaml.py list FILE dotted.key             -> prints list items, one per line

In `list` mode a `*` segment fans out over every value of a dict, so e.g.
`list FILE repositories.*.local_path` prints each repo's local_path, one per line.
"""
import sys


def _strip_comment(line):
    out = []
    q = None
    for i, c in enumerate(line):
        if q:
            out.append(c)
            if c == q:
                q = None
        elif c in ('"', "'"):
            q = c
            out.append(c)
        elif c == '#' and (i == 0 or line[i - 1] in ' \t'):
            break
        else:
            out.append(c)
    return ''.join(out).rstrip()


def _unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1]
    return s


def _split_top(s, sep):
    parts, depth, q, cur = [], 0, None, ''
    for c in s:
        if q:
            cur += c
            if c == q:
                q = None
        elif c in ('"', "'"):
            q = c
            cur += c
        elif c in '[{':
            depth += 1
            cur += c
        elif c in ']}':
            depth -= 1
            cur += c
        elif c == sep and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += c
    parts.append(cur)
    return parts


def _split_first_colon(s):
    """Split on the first TOP-LEVEL mapping colon (outside quotes/brackets, followed
    by whitespace or end-of-string). Returns (key, value) or None if not a map entry."""
    depth, q = 0, None
    for i, c in enumerate(s):
        if q:
            if c == q:
                q = None
        elif c in ('"', "'"):
            q = c
        elif c in '[{':
            depth += 1
        elif c in ']}':
            depth -= 1
        elif c == ':' and depth == 0:
            if i + 1 >= len(s) or s[i + 1] in ' \t':
                return s[:i], s[i + 1:].strip()
    return None


def _parse_scalar(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1]                       # quoted → always a literal string
    if s.lower() in ('null', '~'):
        return None                          # match PyYAML: bare null/~ → None
    return s


def _parse_value(s):
    s = s.strip()
    if s.startswith('['):
        inner = s[1:-1].strip()
        return [] if not inner else [_parse_value(x) for x in _split_top(inner, ',')]
    if s.startswith('{'):
        inner = s[1:-1].strip()
        d = {}
        if inner:
            for part in _split_top(inner, ','):
                kv = _split_first_colon(part) or (
                    part.split(':', 1) if ':' in part else None)
                if kv:
                    d[_unquote(kv[0])] = _parse_value(kv[1])
        return d
    return _parse_scalar(s)


def _is_seq(content):
    return content == '-' or content.startswith('- ')


def _is_block_scalar(v):
    # `|`, `>`, `|-`, `|+`, `>-`, `>+` (with optional trailing digit) start a block scalar.
    return len(v) >= 1 and v[0] in '|>' and v[1:].strip('+-0123456789') == ''


def _load_fallback(text):
    lines = []
    for ln in text.split('\n'):
        s = _strip_comment(ln)
        if s.strip() in ('', '---'):
            continue
        lines.append((len(s) - len(s.lstrip(' ')), s.strip()))
    n = len(lines)
    pos = [0]

    def parse_child(parent_indent):
        # Parse the block that is the VALUE of a key at parent_indent: a deeper map,
        # or a sequence whose dash sits at OR beyond the key's indent (both are legal
        # YAML — the same-indent form is the default of yq / K8s manifests).
        if pos[0] >= n:
            return None
        indent, content = lines[pos[0]]
        if _is_seq(content) and indent >= parent_indent:
            return parse_seq(indent)
        if indent > parent_indent:
            return parse_map(indent)
        return None

    def parse_map(map_indent):
        d = {}
        while pos[0] < n:
            indent, content = lines[pos[0]]
            if indent < map_indent or _is_seq(content):
                break
            if indent > map_indent:
                pos[0] += 1                   # stray deeper line without a parent key
                continue
            kv = _split_first_colon(content)
            if not kv:
                pos[0] += 1
                continue
            key, v = _unquote(kv[0]), kv[1]
            pos[0] += 1
            if v == '':
                d[key] = parse_child(indent)
            elif _is_block_scalar(v):
                # Collect the deeper-indented body as text so its lines don't leak
                # into this map as sibling keys (folding/indentation is not preserved).
                body = []
                while pos[0] < n and lines[pos[0]][0] > indent:
                    body.append(lines[pos[0]][1])
                    pos[0] += 1
                d[key] = '\n'.join(body)
            else:
                d[key] = _parse_value(v)
        return d

    def parse_seq(seq_indent):
        lst = []
        while pos[0] < n:
            indent, content = lines[pos[0]]
            if indent != seq_indent or not _is_seq(content):
                break
            after = content[1:].lstrip(' ')                  # text after the dash
            keycol = indent + (len(content) - len(after)) if after else indent + 1
            pos[0] += 1
            if after == '':
                if pos[0] < n and lines[pos[0]][0] > seq_indent:
                    lst.append(parse_child(seq_indent))
                else:
                    lst.append(None)
            elif _split_first_colon(after) and after[:1] not in '[{"\'':
                # A mapping item, possibly multi-key: first entry here, the rest on
                # following lines aligned at the item's content column (keycol).
                item = {}
                _consume_entry(item, after, keycol)
                while pos[0] < n:
                    ind2, c2 = lines[pos[0]]
                    if ind2 != keycol or _is_seq(c2) or not _split_first_colon(c2):
                        break
                    pos[0] += 1
                    _consume_entry(item, c2, keycol)
                lst.append(item)
            else:
                lst.append(_parse_value(after))
        return lst

    def _consume_entry(item, text, keycol):
        kv = _split_first_colon(text)
        if not kv:
            return
        key, v = _unquote(kv[0]), kv[1]
        if v == '':
            item[key] = parse_child(keycol)
        elif _is_block_scalar(v):
            body = []
            while pos[0] < n and lines[pos[0]][0] > keycol:
                body.append(lines[pos[0]][1])
                pos[0] += 1
            item[key] = '\n'.join(body)
        else:
            item[key] = _parse_value(v)

    if n == 0:
        return {}
    first_indent, first_content = lines[0]
    if _is_seq(first_content):
        result = parse_seq(first_indent)
    else:
        result = parse_map(first_indent)
    return result if result is not None else {}


def load(path):
    # utf-8-sig strips a leading BOM (Windows editors / PowerShell add one), so the
    # first key never glues to a BOM. Universal newlines handle CRLF.
    with open(path, encoding='utf-8-sig') as f:
        text = f.read()
    try:
        import yaml
    except ImportError:
        return _load_fallback(text)
    # A genuine YAML *syntax* error propagates (main() maps it to the default) rather
    # than silently falling through to the naive parser's best-effort guess.
    return yaml.safe_load(text) or {}


def dig(data, dotted):
    cur = data
    for part in dotted.split('.'):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def dig_star(data, dotted):
    """dig with `*` fan-out: a `*` segment matches every value of a dict (e.g.
    repositories.*.local_path -> each repo's local_path). Returns the list of
    matches, possibly empty."""
    cur = [data]
    for part in dotted.split('.'):
        nxt = []
        for c in cur:
            if not isinstance(c, dict):
                continue
            if part == '*':
                nxt.extend(c.values())
            elif part in c:
                nxt.append(c[part])
        cur = nxt
    return cur


def main(argv):
    if len(argv) < 4:
        return 0
    mode, path, key = argv[1], argv[2], argv[3]
    default = argv[4] if len(argv) > 4 else ''
    try:
        data = load(path)
    except Exception:
        if mode == 'get':
            sys.stdout.write(default)
        return 0
    if mode == 'list' and '*' in key.split('.'):
        for item in dig_star(data, key):
            if item is not None and not isinstance(item, (list, dict)):
                print(item)
        return 0
    val = dig(data, key)
    if mode == 'get':
        if val is None or isinstance(val, (list, dict)):
            sys.stdout.write(default)
        elif isinstance(val, bool):
            sys.stdout.write('true' if val else 'false')
        else:
            sys.stdout.write(str(val))
    elif mode == 'list':
        if isinstance(val, list):
            for item in val:
                if item is not None and not isinstance(item, (list, dict)):
                    print(item)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
