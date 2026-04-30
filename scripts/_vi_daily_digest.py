#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vi Daily Digest — T27-IMPLEMENT.

Origen: Wi firmo mail [164] [NUEVA-TAREA-T27-DIGEST-VI]. Mariano firmo:
"si te sirve a Wi, mejor; pero tambien Vi y TEC". ARQ ya tiene
JUEGA_cron_arq_digest (Task Scheduler 9 AM diario).

Spec:
  - Cron OS-level Task Scheduler: 9 AM todos los dias
  - Compila resumen del dia anterior (ultimas 24h):
    * Cierres Vi (subject [CIERRE-*])
    * Propuestas Vi (subject [PROPUESTA-*])
    * Commits Vi (git log --author --since="yesterday")
    * Tareas pendientes en cola (lista A+B+C)
  - Mail destinatario: SOLO wi.gg@miia-app.com (NO hola@, NO Mariano)
  - Subject: [DIGEST-DIARIO-VI] resumen 24h
  - Patron: similar a ARQ digest

Setup Task Scheduler (post-deploy, Mariano ejecuta):
  schtasks /create /tn "MIIA_cron_vi_digest" \\
    /tr "python C:/Users/usuario/OneDrive/Desktop/miia/miia-backend/scripts/_vi_daily_digest.py" \\
    /sc daily /st 09:00

NO contiene credenciales hardcodeadas. Lee PASS 2 desde Cambios.txt.
"""

import imaplib
import email
import smtplib
import subprocess
import sys
from email.header import decode_header
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta

CAMBIOS = r"C:/Users/usuario/OneDrive/Desktop/miia/.claude/_archivados/Cambios.txt"
BACKEND_PATH = r"C:/Users/usuario/OneDrive/Desktop/miia/miia-backend"


def get_pass2_for(email_addr, header_label):
    """Lee PASS 2 desde Cambios.txt sin imprimir el valor."""
    with open(CAMBIOS, 'r', encoding='utf-8') as f:
        for line in f:
            if email_addr in line and header_label in line and 'PASS 2' in line:
                idx = line.find('PASS 2:')
                if idx == -1:
                    continue
                rest = line[idx + len('PASS 2:'):].strip()
                return rest.replace(' ', '')
    return None


def fetch_my_sent_mails(pwd, hours=24):
    """Lee mails enviados por vi.tec en las ultimas N horas."""
    since = (datetime.now() - timedelta(hours=hours)).strftime("%d-%b-%Y")
    M = imaplib.IMAP4_SSL('imap.gmail.com')
    M.login('vi.tec@miia-app.com', pwd)
    M.select('"[Gmail]/Enviados"')
    typ, data = M.search(None, f'SINCE {since}')
    ids = data[0].split()
    mails = []
    for i in ids:
        typ, msg_data = M.fetch(i, '(RFC822.HEADER)')
        msg = email.message_from_bytes(msg_data[0][1])
        subj = msg.get('Subject', '')
        if subj:
            decoded = decode_header(subj)
            subj = ''.join([(s.decode(c or 'utf-8') if isinstance(s, bytes) else s) for s, c in decoded])
        date = msg.get('Date', '')[:25]
        to = msg.get('To', '')
        mails.append({'date': date, 'subj': subj, 'to': to})
    M.close()
    M.logout()
    return mails


def get_git_commits_yesterday():
    """Lista commits del autor en las ultimas 24h."""
    try:
        result = subprocess.run(
            ['git', '-C', BACKEND_PATH, 'log',
             '--since=24 hours ago',
             '--pretty=format:%h %ad %s',
             '--date=short'],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return [f"git log error: {result.stderr.strip()[:100]}"]
        lines = [ln for ln in result.stdout.splitlines() if ln.strip()]
        return lines if lines else ['(sin commits en 24h)']
    except Exception as e:
        return [f"git exec error: {str(e)[:100]}"]


def categorize_mails(mails):
    """Clasifica mails en CIERRES vs PROPUESTAS vs OTROS."""
    cierres = [m for m in mails if 'CIERRE' in m['subj'].upper()]
    propuestas = [m for m in mails if 'PROPUESTA' in m['subj'].upper()]
    acks = [m for m in mails if m['subj'].upper().startswith('[ACK')]
    otros = [m for m in mails
             if 'CIERRE' not in m['subj'].upper()
             and 'PROPUESTA' not in m['subj'].upper()
             and not m['subj'].upper().startswith('[ACK')]
    return {'cierres': cierres, 'propuestas': propuestas, 'acks': acks, 'otros': otros}


def build_digest_body(buckets, commits):
    """Construye el body del mail digest."""
    lines = []
    lines.append("Wi,")
    lines.append("")
    lines.append(f"[DIGEST-DIARIO-VI] resumen 24h — {datetime.now().strftime('%Y-%m-%d')}")
    lines.append("")
    lines.append(f"=" * 70)
    lines.append(f"CIERRES Vi ({len(buckets['cierres'])})")
    lines.append(f"=" * 70)
    for m in buckets['cierres']:
        lines.append(f"  {m['date']}  {m['subj']}")
    if not buckets['cierres']:
        lines.append("  (ninguno)")
    lines.append("")
    lines.append(f"=" * 70)
    lines.append(f"PROPUESTAS Vi ({len(buckets['propuestas'])})")
    lines.append(f"=" * 70)
    for m in buckets['propuestas']:
        lines.append(f"  {m['date']}  {m['subj']}")
    if not buckets['propuestas']:
        lines.append("  (ninguno)")
    lines.append("")
    lines.append(f"=" * 70)
    lines.append(f"COMMITS GIT (24h)")
    lines.append(f"=" * 70)
    for c in commits:
        lines.append(f"  {c}")
    lines.append("")
    lines.append(f"=" * 70)
    lines.append(f"ACKS / OTROS ({len(buckets['acks']) + len(buckets['otros'])})")
    lines.append(f"=" * 70)
    lines.append(f"  ACKs:  {len(buckets['acks'])}")
    lines.append(f"  Otros: {len(buckets['otros'])}")
    lines.append("")
    lines.append("Vi TEC — digest automatico")
    return "\n".join(lines)


def send_digest(pwd, body):
    """Envia el digest a wi.gg@miia-app.com (SOLO, no hola@)."""
    msg = MIMEMultipart()
    msg['From'] = 'vi.tec@miia-app.com'
    msg['To'] = 'wi.gg@miia-app.com'
    msg['Subject'] = f"[DIGEST-DIARIO-VI] resumen 24h — {datetime.now().strftime('%Y-%m-%d')}"
    msg.attach(MIMEText(body, 'plain', 'utf-8'))
    with smtplib.SMTP('smtp.gmail.com', 587) as server:
        server.ehlo()
        server.starttls()
        server.login('vi.tec@miia-app.com', pwd)
        server.sendmail('vi.tec@miia-app.com', ['wi.gg@miia-app.com'], msg.as_string())


def main():
    pwd = get_pass2_for('vi.tec@miia-app.com', 'EMAIL VI TEC')
    if not pwd:
        print("ERROR: no se pudo leer PASS 2 vi.tec desde Cambios.txt", file=sys.stderr)
        sys.exit(1)

    try:
        mails = fetch_my_sent_mails(pwd, hours=24)
    except Exception as e:
        print(f"ERROR fetch sent mails: {e}", file=sys.stderr)
        sys.exit(2)

    buckets = categorize_mails(mails)
    commits = get_git_commits_yesterday()
    body = build_digest_body(buckets, commits)

    # Modo dry-run: solo imprime, no envia
    if '--dry-run' in sys.argv:
        print(body)
        return

    try:
        send_digest(pwd, body)
        print(f"OK digest enviado: {len(buckets['cierres'])} cierres + {len(buckets['propuestas'])} propuestas + {len(commits)} commits")
    except Exception as e:
        print(f"ERROR send digest: {e}", file=sys.stderr)
        sys.exit(3)


if __name__ == '__main__':
    main()
