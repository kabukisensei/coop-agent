#!/usr/bin/env python3
"""Dependency-free YAML reader for coop.

coop must work on a fresh machine where the system python has no PyYAML, so this
module is the ONE YAML parser coop uses: it never imports PyYAML, and a file reads
the same on every machine whether or not PyYAML happens to be installed. It
handles the subset coop's .coop/project.yml and ~/.coop files use: nested block
maps, block lists (dash at the same OR deeper indent than the key), multi-key
block-list items, inline flow lists [a, b], inline flow maps {k: v}, quoted and
plain scalars, and # comments. Block scalars (| / >) are captured as text (not
parsed as keys) but not folded; anchors, aliases, and tags are out of scope.

Plain (unquoted) scalars are coerced like the YAML 1.2 core schema:
`true`/`True`/`TRUE` and `false`/`False`/`FALSE` -> bool, `null`/`Null`/`NULL`/`~`
and an empty value -> None, decimal/0o/0x integers -> int, floats (including
`.inf`/`.nan`) -> float, everything else -> str. `yes`/`no`/`on`/`off` stay text.
A quoted scalar is always a str.

Usage:
    python3 _yaml.py get  FILE dotted.key [default]   -> prints scalar (or default)
    python3 _yaml.py list FILE dotted.key             -> prints list items, one per line

`get` prints a bool as `true` / `false` (what the PowerShell callers compare
against), an int or float with str(), and the default for a null, list or map.

In `list` mode a `*` segment fans out over every value of a dict, so e.g.
`list FILE repositories.*.local_path` prints each repo's local_path, one per line.
"""
import re
import sys


def _opens_quote(s, i):
    """A quote character starts a quoted scalar only at the start of a value: at
    the start of the line or right after `:`, `-`, `[`, `{` or `,` (plus spaces).
    An apostrophe inside an unquoted value (Aaron's) is a plain character."""
    j = i - 1
    while j >= 0 and s[j] in ' \t':
        j -= 1
    return j < 0 or s[j] in ':-[{,'


def _strip_comment(line):
    out = []
    q = None
    for i, c in enumerate(line):
        if q:
            out.append(c)
            if c == q:
                q = None
        elif c in ('"', "'") and _opens_quote(line, i):
            q = c
            out.append(c)
        elif c == '#' and (i == 0 or line[i - 1] in ' \t'):
            break
        else:
            out.append(c)
    return ''.join(out).rstrip()


_DQ_ESCAPES = {'\\': '\\', '"': '"', 'n': '\n', 't': '\t', 'r': '\r', '/': '/', '0': '\0'}


def _decode_double_quoted(body):
    """Decode the common escapes of a double-quoted scalar (what PyYAML would)."""
    if '\\' not in body:
        return body
    out, i = [], 0
    while i < len(body):
        c = body[i]
        if c == '\\' and i + 1 < len(body) and body[i + 1] in _DQ_ESCAPES:
            out.append(_DQ_ESCAPES[body[i + 1]])
            i += 2
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def _unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] == "'":
        return s[1:-1].replace("''", "'")
    if len(s) >= 2 and s[0] == s[-1] == '"':
        return _decode_double_quoted(s[1:-1])
    return s


def _split_top(s, sep):
    parts, depth, q, cur = [], 0, None, ''
    for i, c in enumerate(s):
        if q:
            cur += c
            if c == q:
                q = None
        elif c in ('"', "'") and _opens_quote(s, i):
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
        elif c in ('"', "'") and _opens_quote(s, i):
            q = c
        elif c in '[{':
            depth += 1
        elif c in ']}':
            depth -= 1
        elif c == ':' and depth == 0:
            if i + 1 >= len(s) or s[i + 1] in ' \t':
                return s[:i], s[i + 1:].strip()
    return None


# YAML 1.2 core schema (section 10.3.2): the plain-scalar forms that are not strings.
_CORE_NULL = frozenset(('', 'null', 'Null', 'NULL', '~'))
_CORE_TRUE = frozenset(('true', 'True', 'TRUE'))
_CORE_FALSE = frozenset(('false', 'False', 'FALSE'))
_CORE_INT_DEC = re.compile(r'[-+]?[0-9]+\Z')
_CORE_INT_OCT = re.compile(r'0o[0-7]+\Z')
_CORE_INT_HEX = re.compile(r'0x[0-9a-fA-F]+\Z')
_CORE_FLOAT = re.compile(r'[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?\Z')
_CORE_INF = re.compile(r'[-+]?\.(inf|Inf|INF)\Z')
_CORE_NAN = re.compile(r'\.(nan|NaN|NAN)\Z')


def _coerce_plain(s):
    """A plain (unquoted) scalar's value under the core schema; str when no
    non-string form matches, so `0.79.0`, `main`, `yes` and GUIDs stay text."""
    if s in _CORE_NULL:
        return None
    if s in _CORE_TRUE:
        return True
    if s in _CORE_FALSE:
        return False
    if _CORE_INT_DEC.match(s):
        return int(s, 10)
    if _CORE_INT_OCT.match(s):
        return int(s[2:], 8)
    if _CORE_INT_HEX.match(s):
        return int(s[2:], 16)
    if _CORE_FLOAT.match(s):
        return float(s)
    if _CORE_INF.match(s):
        return float('-inf') if s.startswith('-') else float('inf')
    if _CORE_NAN.match(s):
        return float('nan')
    return s


def _parse_scalar(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] == "'":
        return s[1:-1].replace("''", "'")  # YAML single-quote escaping
    if len(s) >= 2 and s[0] == s[-1] == '"':
        return _decode_double_quoted(s[1:-1])  # quoted → always a literal string
    return _coerce_plain(s)


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
    # The parser itself; `loads` / `load` are the public names (the old name stays
    # for the tests and callers that reach it directly).
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


def loads(text):
    """Parse YAML text with coop's own parser (never PyYAML). Returns {} for an
    empty document."""
    return _load_fallback(text)


def load(path):
    # utf-8-sig strips a leading BOM (Windows editors / PowerShell add one), so the
    # first key never glues to a BOM. Universal newlines handle CRLF.
    with open(path, encoding='utf-8-sig') as f:
        text = f.read()
    return loads(text)


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
