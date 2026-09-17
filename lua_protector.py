"""Conservative Lua source protector.

This is intentionally syntax-preserving: it removes comments, normalizes
whitespace outside strings, and renames simple local identifiers without
touching quoted strings, long strings, property names after a dot, or Lua
keywords. It is not a substitute for a native Luau compiler/VM obfuscator.
"""
import re
from typing import Dict, List, Tuple

KEYWORDS = {
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
    "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then",
    "true", "until", "while", "self",
}
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _scan(source: str) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    i = 0
    n = len(source)
    while i < n:
        if source.startswith("--[[", i):
            end = source.find("]]", i + 4)
            i = n if end < 0 else end + 2
            out.append(("space", " "))
            continue
        if source.startswith("--", i):
            end = source.find("\n", i + 2)
            i = n if end < 0 else end
            out.append(("space", "\n"))
            continue
        if source.startswith("[[", i):
            end = source.find("]]", i + 2)
            end = n if end < 0 else end + 2
            out.append(("string", source[i:end]))
            i = end
            continue
        if source[i] in "'\"":
            quote = source[i]
            j = i + 1
            while j < n:
                if source[j] == "\\":
                    j += 2
                    continue
                if source[j] == quote:
                    j += 1
                    break
                j += 1
            out.append(("string", source[i:j]))
            i = j
            continue
        if source[i].isspace():
            j = i + 1
            while j < n and source[j].isspace():
                j += 1
            out.append(("space", " "))
            i = j
            continue
        m = re.match(r"[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?", source[i:])
        if m:
            token = m.group(0)
            out.append(("word", token))
            i += len(token)
            continue
        out.append(("punct", source[i]))
        i += 1
    return out


def _local_names(tokens: List[Tuple[str, str]]) -> List[str]:
    names: List[str] = []
    for i, (kind, value) in enumerate(tokens):
        if kind != "word" or value != "local":
            continue
        j = i + 1
        while j < len(tokens) and tokens[j][0] == "space":
            j += 1
        if j < len(tokens) and tokens[j][1] == "function":
            j += 1
            while j < len(tokens) and tokens[j][0] == "space":
                j += 1
        while j < len(tokens):
            kind2, value2 = tokens[j]
            if kind2 == "word" and value2 not in KEYWORDS:
                names.append(value2)
                j += 1
                while j < len(tokens) and tokens[j][0] == "space":
                    j += 1
                if j < len(tokens) and tokens[j][1] == ",":
                    j += 1
                    continue
            break
    return list(dict.fromkeys(names))


def protect_lua(source: str) -> Tuple[str, Dict[str, int]]:
    tokens = _scan(source)
    original_names = _local_names(tokens)
    rename: Dict[str, str] = {}
    for index, name in enumerate(original_names, start=1):
        rename[name] = f"v_{index:02x}"
    result: List[str] = []
    prev_word = False
    for i, (kind, value) in enumerate(tokens):
        if kind == "space":
            if result and not result[-1].endswith((" ", "\n")):
                result.append(" ")
            prev_word = False
            continue
        if kind == "string":
            result.append(value)
            prev_word = False
            continue
        if kind == "word":
            if value in rename and not (i > 0 and tokens[i - 1][1] == "."):
                value = rename[value]
            if prev_word:
                result.append(" ")
            result.append(value)
            prev_word = True
            continue
        result.append(value)
        prev_word = False
    protected = "".join(result).strip()
    protected = re.sub(r"[ \t]+\n", "\n", protected)
    protected = re.sub(r"\n{3,}", "\n\n", protected)
    return protected, {"renamed_locals": len(rename), "source_bytes": len(source.encode()), "protected_bytes": len(protected.encode())}
