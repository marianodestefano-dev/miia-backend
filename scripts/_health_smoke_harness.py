#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Health Smoke Harness — T31-IMPLEMENT.

Origen: Wi mail [167] [ACK-T24-T25-T26-T27+N4-VI] — "T31 Health check
production smoke harness (verificacion automatica)".

Objetivo: script que verifica /api/health del deploy production y reporta
status + latencias + alertas. Util para:
  - Cron periodico (cada 15 min) si Mariano lo activa via Task Scheduler
  - Run manual post-deploy para validar antes de cierre
  - CI gate (futuro): si overall != healthy → fail build

Endpoint: https://miia-backend-production.up.railway.app/api/health
(URL verificada en CLAUDE.md datos fijos + scripts existentes).

Modos:
  - default: imprime resumen humano-legible (success exit 0, fail exit 1)
  - --json: imprime response JSON completo (para piping)
  - --strict: exit 1 si overall != 'healthy' (para CI gate)
  - --notify: si overall != 'healthy', envia mail a wi.gg@ (alerta)

NO contiene credenciales. Solo HTTPS GET publico al /health (no requiere auth).
"""

import sys
import json
import urllib.request
import urllib.error
from datetime import datetime

HEALTH_URL = 'https://miia-backend-production.up.railway.app/api/health'
TIMEOUT_SECONDS = 15


def fetch_health():
    """HTTPS GET con timeout. Retorna (status_code, body_dict | None, error_msg)."""
    req = urllib.request.Request(HEALTH_URL, headers={
        'User-Agent': 'MIIA-HealthHarness/1.0 (T31)',
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            status = resp.status
            raw = resp.read().decode('utf-8', errors='replace')
            try:
                body = json.loads(raw)
            except Exception as e:
                return status, None, f"invalid JSON: {str(e)[:80]}"
            return status, body, None
    except urllib.error.HTTPError as e:
        return e.code, None, f"HTTPError: {e.reason}"
    except urllib.error.URLError as e:
        return None, None, f"URLError: {str(e.reason)[:80]}"
    except Exception as e:
        return None, None, f"Exception: {str(e)[:120]}"


def format_summary(status, body, error_msg):
    """Resumen humano-legible."""
    lines = []
    lines.append(f"=== MIIA Health Smoke Harness — {datetime.now().isoformat(timespec='seconds')} ===")
    lines.append(f"Endpoint: {HEALTH_URL}")
    lines.append("")

    if error_msg:
        lines.append(f"FAIL: status={status} error={error_msg}")
        return "\n".join(lines)

    if status != 200:
        lines.append(f"FAIL: HTTP {status} (esperado 200)")
        return "\n".join(lines)

    overall = body.get('status', 'unknown')
    uptime = body.get('uptime', 0)
    lines.append(f"Overall status: {overall}")
    lines.append(f"Uptime: {uptime}s ({uptime // 60}m)")
    lines.append(f"Last full check: {body.get('lastFullCheck', 'unknown')}")
    lines.append("")

    components = body.get('components', {})

    # Firestore
    fs = components.get('firestore', {})
    lines.append(f"Firestore: {fs.get('status', 'unknown')}")
    lines.append(f"  latencyMs: {fs.get('latencyMs', 'N/A')}")
    lines.append(f"  failures: {fs.get('failures', 0)}")
    if fs.get('latency'):
        pct = fs['latency']
        lines.append(f"  T24 latency rolling: p50={pct.get('p50')}ms p95={pct.get('p95')}ms p99={pct.get('p99')}ms (n={pct.get('samples')})")

    # AI Gateway
    ai = components.get('aiGateway', {})
    lines.append(f"AI Gateway: {ai.get('status', 'unknown')}")
    lines.append(f"  latencyMs: {ai.get('latencyMs', 'N/A')}")
    if ai.get('latency'):
        pct = ai['latency']
        lines.append(f"  T24 latency rolling: p50={pct.get('p50')}ms p95={pct.get('p95')}ms p99={pct.get('p99')}ms (n={pct.get('samples')})")

    # Baileys tenants
    baileys = components.get('baileys', [])
    lines.append(f"Baileys tenants: {len(baileys)}")
    for b in baileys[:5]:  # max 5 lines
        lines.append(f"  - {b.get('uid', '?')} status={b.get('status', '?')} failures={b.get('failures', 0)}")

    # Messages upsert (T11a ZOMBIE detection)
    upsert = components.get('messagesUpsert', {})
    lines.append(f"Messages upsert: {upsert.get('status', '?')}")
    lines.append(f"  10min: {upsert.get('count10min', 0)} | 20min: {upsert.get('count20min', 0)}")
    last_upsert = upsert.get('lastUpsertAt', 'never')
    lines.append(f"  lastUpsertAt: {last_upsert}")

    return "\n".join(lines)


def detect_alerts(body):
    """Retorna lista de alertas segun status. Vacio si todo OK."""
    alerts = []
    if not body:
        return ['no body']

    overall = body.get('status', 'unknown')
    if overall in ('critical', 'degraded'):
        alerts.append(f"overall={overall}")

    components = body.get('components', {})
    fs = components.get('firestore', {})
    if fs.get('status') in ('critical', 'degraded'):
        alerts.append(f"firestore={fs.get('status')}")

    ai = components.get('aiGateway', {})
    if ai.get('status') in ('critical', 'degraded'):
        alerts.append(f"aiGateway={ai.get('status')}")

    upsert = components.get('messagesUpsert', {})
    if upsert.get('status') in ('critical', 'warn'):
        alerts.append(f"messagesUpsert={upsert.get('status')}")

    baileys = components.get('baileys', [])
    disconnected = [b for b in baileys if b.get('status') == 'disconnected']
    if disconnected:
        alerts.append(f"baileys_disconnected={len(disconnected)}")

    return alerts


def main():
    args = sys.argv[1:]
    json_mode = '--json' in args
    strict_mode = '--strict' in args
    notify_mode = '--notify' in args

    status, body, error_msg = fetch_health()

    if json_mode and body:
        print(json.dumps(body, indent=2))
        if error_msg or status != 200:
            sys.exit(1)
        sys.exit(0)

    summary = format_summary(status, body, error_msg)
    print(summary)

    # Strict mode: fail si overall != healthy
    overall = body.get('status') if body else None
    alerts = detect_alerts(body) if body else ['no body']

    if alerts:
        print("")
        print(f"ALERTAS ({len(alerts)}): {', '.join(alerts)}")

    if strict_mode and overall != 'healthy':
        sys.exit(1)

    if error_msg or status != 200:
        sys.exit(1)

    sys.exit(0)


if __name__ == '__main__':
    main()
