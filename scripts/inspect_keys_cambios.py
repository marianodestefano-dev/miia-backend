"""
inspect_keys_cambios.py — C-426 §C.1

Parser line-based de Cambios.txt para identificar API keys productivas.
NUNCA imprime valores. Solo metadata: categoría, label found, valueLen,
posición, fecha rotación si parseable de la línea.

R-H3 estricto: NO grep/cut/sed/awk. Solo parser Python line-based.

Usage:
  python miia-backend/scripts/inspect_keys_cambios.py
  python miia-backend/scripts/inspect_keys_cambios.py --json
"""

import json
import os
import re
import sys

CAMBIOS = r"c:/Users/usuario/OneDrive/Desktop/miia/.claude/_archivados/Cambios.txt"

# Categorías productivas: (keyword en línea → label normalizado)
CATEGORIES = [
    ('ANTHROPIC',  re.compile(r'\b(ANTHROPIC|claude[_\-\s]*api)\b', re.IGNORECASE)),
    ('GEMINI',     re.compile(r'\b(GEMINI|google[_\-\s]*ai)\b', re.IGNORECASE)),
    ('OPENAI',     re.compile(r'\b(OPENAI|openai)\b', re.IGNORECASE)),
    ('RAILWAY',    re.compile(r'\b(RAILWAY)\b', re.IGNORECASE)),
    ('FIREBASE',   re.compile(r'\b(FIREBASE|firebase)\b', re.IGNORECASE)),
    ('GOOGLE_CAL', re.compile(r'\b(GOOGLE[_\-\s]*CAL|CALENDAR)\b', re.IGNORECASE)),
    ('GOOGLE_OAUTH', re.compile(r'\b(GOOGLE[_\-\s]*OAUTH|oauth.*google)\b', re.IGNORECASE)),
    ('STRIPE',     re.compile(r'\b(STRIPE)\b', re.IGNORECASE)),
    ('PADDLE',     re.compile(r'\b(PADDLE)\b', re.IGNORECASE)),
    ('ELEVENLABS', re.compile(r'\b(ELEVENLABS|eleven)\b', re.IGNORECASE)),
    ('TELEGRAM',   re.compile(r'\b(TELEGRAM)\b', re.IGNORECASE)),
    ('EMAIL_APP',  re.compile(r'^EMAIL\s+(WI|VI|ARQ|TEC)\s', re.IGNORECASE)),
]

# Patrones de "valor" para detectar keys reales (no solo labels):
# - "<LABEL>: <value>"
# - "<LABEL>=<value>"
# - "PASS X: <value>"
KEY_VALUE_RE = re.compile(r'\b(?:[A-Z][A-Z0-9_]+|PASS\s*\d*)\s*[:=]\s*\S')


def main():
    json_out = '--json' in sys.argv

    if not os.path.isfile(CAMBIOS):
        print(f"ERR: Cambios.txt not found at {CAMBIOS}", file=sys.stderr)
        return 1

    with open(CAMBIOS, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    report = {
        'file': CAMBIOS,
        'total_lines': len(lines),
        'lines_with_value': 0,
        'categories': {cat: {'count': 0, 'labels': []} for cat, _ in CATEGORIES},
        'uncategorized_with_value': 0,
        'last_rotation_hint': None,
    }

    for idx, line in enumerate(lines):
        stripped = line.rstrip('\r\n')
        if not stripped.strip():
            continue

        has_value = bool(KEY_VALUE_RE.search(stripped))
        if has_value:
            report['lines_with_value'] += 1

        # Parse "label" prefix without value
        # Common patterns:
        #   "ANTHROPIC_API_KEY: sk-ant-...."
        #   "EMAIL WI GG - wi.gg@miia-app.com - PASS 2: ...."
        #   "Railway token: ...."
        # Extract token before first ':' or '=' or '-' for label heuristic
        label_match = re.match(r'^\s*([A-Z][A-Z0-9_\-\s]{1,40})[:=]', stripped)
        if not label_match:
            label_match = re.match(r'^\s*([A-Za-z][A-Za-z0-9_\-\s]{1,40})[:=]', stripped)
        label = label_match.group(1).strip() if label_match else None

        matched_category = False
        for cat, regex in CATEGORIES:
            if regex.search(stripped):
                report['categories'][cat]['count'] += 1
                if label and label not in report['categories'][cat]['labels']:
                    report['categories'][cat]['labels'].append(label)
                matched_category = True
                break

        if not matched_category and has_value:
            report['uncategorized_with_value'] += 1

        # Detect rotation hint: dates next to LABEL (year-month-day)
        rot_match = re.search(r'(rotad[ao]|rotated|last\s*rotated?)\s*[:=]?\s*(\d{4}-\d{2}-\d{2})', stripped, re.IGNORECASE)
        if rot_match:
            report['last_rotation_hint'] = rot_match.group(2)

    if json_out:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"Cambios.txt inspection report (R-H3 safe — no values printed)")
        print(f"=" * 64)
        print(f"File:                {report['file']}")
        print(f"Total lines:         {report['total_lines']}")
        print(f"Lines with value:    {report['lines_with_value']}")
        print(f"Uncategorized:       {report['uncategorized_with_value']}")
        print(f"Last rotation hint:  {report['last_rotation_hint'] or '(none in file)'}")
        print(f"-" * 64)
        print(f"Categories detected:")
        for cat, info in report['categories'].items():
            if info['count'] > 0:
                labels_str = ', '.join(info['labels'][:3])
                if len(info['labels']) > 3:
                    labels_str += f" (+{len(info['labels']) - 3} more)"
                print(f"  {cat:14s} count={info['count']:2d} labels=[{labels_str}]")
        print(f"=" * 64)

    return 0


if __name__ == '__main__':
    sys.exit(main())
