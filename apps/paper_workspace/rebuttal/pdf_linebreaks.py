"""Normalize hard line wraps extracted from review PDFs."""
from __future__ import annotations

import re

LIST_START = re.compile(r'^(?:\d{1,3}[.)]|[-*•])\s+')
STRUCTURED = re.compile(r'^(?:#{1,6}\s|>|\||```|~~~|\$\$|\\(?:begin|end)\s*\{)')


def normalize(value: str):
    """Join single PDF line wraps, preserving paragraphs, lists, and math/code blocks."""
    text = value
    changes = []
    fence = False
    math = False
    environment = 0
    offset = 0
    lines = text.splitlines(keepends=True)
    list_indent = 0
    code_lines = []
    for line in lines:
        content = line.rstrip('\r\n').expandtabs(4)
        stripped = content.lstrip()
        indent = len(content) - len(stripped)
        if stripped and indent < list_indent:
            list_indent = 0
        code_lines.append(bool(stripped) and indent >= list_indent + 4)
        if not code_lines[-1] and (marker := LIST_START.match(stripped)):
            list_indent = indent + marker.end()

    for i, line in enumerate(lines[:-1]):
        content = line.rstrip('\r\n')
        stripped = content.strip()
        if not code_lines[i] and stripped.startswith(('```', '~~~')):
            fence = not fence
        if not code_lines[i] and stripped.count('$$') % 2:
            math = not math
        if not code_lines[i]:
            environment += len(re.findall(r'\\begin\s*\{', stripped)) - len(re.findall(r'\\end\s*\{', stripped))
        end = offset + len(line)
        following = lines[i+1].lstrip(' \t')
        next_text = following.rstrip('\r\n')
        leading = len(lines[i+1]) - len(following)
        newline_len = len(line) - len(content)
        if (newline_len and stripped and next_text.strip() and not fence and not math and environment <= 0
                and not code_lines[i] and not code_lines[i+1]
                and not LIST_START.match(next_text) and not STRUCTURED.match(next_text)
                and not STRUCTURED.match(stripped) and not stripped.endswith(':')):
            changes.append((end - newline_len, end + leading))
        offset = end
    mapping = [None] * (len(text) + 1)
    output = []
    source_pos = dest_pos = 0
    for start, end in changes:
        if start < source_pos: continue
        piece = text[source_pos:start]
        output.append(piece)
        for p in range(source_pos, start + 1): mapping[p] = dest_pos + (p-source_pos)
        dest_pos += len(piece)
        output.append(' ')
        mapping[start] = dest_pos
        mapping[end] = dest_pos + 1
        dest_pos += 1
        source_pos = end
    output.append(text[source_pos:])
    for p in range(source_pos, len(text)+1): mapping[p] = dest_pos + (p-source_pos)
    return ''.join(output), mapping, len(changes)
