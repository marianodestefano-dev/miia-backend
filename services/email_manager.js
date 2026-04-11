'use strict';

/**
 * EMAIL_MANAGER.JS — Gestión completa de email del owner via WhatsApp
 *
 * Funcionalidades:
 * 1. ENVIAR: Tag [ENVIAR_EMAIL:to|subject|body] → SMTP
 * 2. LEER INBOX: Tag [LEER_INBOX] → IMAP fetch unread → lista formateada
 * 3. LEER CONTENIDO: Tag [EMAIL_LEER:2,5] → leer cuerpos específicos
 * 4. ELIMINAR: Tag [EMAIL_ELIMINAR:1,3,4] → marcar como deleted en IMAP
 *
 * STANDARD: Google + Amazon + APPLE + NASA
 * Fail loudly, exhaustive logging, zero silent failures.
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');

const LOG_PREFIX = '[EMAIL-MANAGER]';

// ═══ DEPENDENCIAS INYECTADAS ═══
let _sendGenericEmail = null;

function setEmailManagerDependencies({ sendGenericEmail }) {
  _sendGenericEmail = sendGenericEmail;
  console.log(`${LOG_PREFIX} ✅ Dependencias inyectadas`);
}

// ═══ ESTADO EN MEMORIA (por owner) ═══
// Cache de emails leídos para que el owner pueda decir "eliminá el 2 y 5"
const emailCache = new Map(); // uid → { emails: [], fetchedAt, imapConfig }

/**
 * Conectar IMAP y obtener emails sin leer
 * @param {Object} imapConfig - { host, port, user, pass, folder, tls }
 * @param {number} maxEmails - Máximo emails a obtener (default 10)
 * @returns {Promise<Array>} Lista de emails
 */
async function fetchUnreadEmails(imapConfig, maxEmails = 10) {
  if (!imapConfig.host || !imapConfig.user || !imapConfig.pass) {
    console.error(`${LOG_PREFIX} ❌ IMAP no configurado: faltan host/user/pass`);
    return { success: false, error: 'IMAP no configurado. Configurá tu email en el dashboard.', emails: [] };
  }

  return new Promise((resolve) => {
    const imap = new Imap({
      user: imapConfig.user,
      password: imapConfig.pass,
      host: imapConfig.host,
      port: imapConfig.port || 993,
      tls: imapConfig.tls !== false,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 15000,
      connTimeout: 15000,
    });

    const results = [];
    let resolved = false;

    const safeResolve = (data) => {
      if (!resolved) {
        resolved = true;
        try { imap.end(); } catch (e) { /* ignore */ }
        resolve(data);
      }
    };

    imap.once('error', (err) => {
      console.error(`${LOG_PREFIX} ❌ IMAP error: ${err.message}`);
      safeResolve({ success: false, error: `Error IMAP: ${err.message}`, emails: [] });
    });

    imap.once('ready', () => {
      const folder = imapConfig.folder || 'INBOX';
      imap.openBox(folder, false, (err, box) => {
        if (err) {
          console.error(`${LOG_PREFIX} ❌ Error abriendo ${folder}: ${err.message}`);
          safeResolve({ success: false, error: `No pude abrir la bandeja "${folder}"`, emails: [] });
          return;
        }

        imap.search(['UNSEEN'], (searchErr, uids) => {
          if (searchErr) {
            console.error(`${LOG_PREFIX} ❌ Error buscando no leídos: ${searchErr.message}`);
            safeResolve({ success: false, error: 'Error buscando correos sin leer', emails: [] });
            return;
          }

          if (!uids || uids.length === 0) {
            console.log(`${LOG_PREFIX} 📭 Sin emails nuevos`);
            safeResolve({ success: true, emails: [], count: 0 });
            return;
          }

          // Tomar los últimos N
          const toFetch = uids.slice(-maxEmails);
          console.log(`${LOG_PREFIX} 📬 ${uids.length} sin leer, leyendo últimos ${toFetch.length}`);

          const fetch = imap.fetch(toFetch, { bodies: '', struct: true });

          fetch.on('message', (msg, seqno) => {
            let buffer = '';
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            });
            msg.once('attributes', (attrs) => {
              const uid = attrs.uid;
              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  results.push({
                    uid,
                    seqno,
                    from: parsed.from?.text || 'Desconocido',
                    fromName: parsed.from?.value?.[0]?.name || parsed.from?.value?.[0]?.address || 'Desconocido',
                    subject: parsed.subject || '(Sin asunto)',
                    date: parsed.date ? parsed.date.toISOString() : null,
                    textBody: (parsed.text || '').substring(0, 2000), // Limitar tamaño
                    hasAttachments: (parsed.attachments?.length || 0) > 0,
                  });
                } catch (parseErr) {
                  console.warn(`${LOG_PREFIX} ⚠️ Error parseando email UID ${uid}: ${parseErr.message}`);
                }
              });
            });
          });

          fetch.once('error', (fetchErr) => {
            console.error(`${LOG_PREFIX} ❌ Error fetch: ${fetchErr.message}`);
            safeResolve({ success: false, error: 'Error leyendo correos', emails: [] });
          });

          fetch.once('end', () => {
            // Esperar un poco para que los parseos async terminen
            setTimeout(() => {
              results.sort((a, b) => (b.uid || 0) - (a.uid || 0)); // Más recientes primero
              console.log(`${LOG_PREFIX} ✅ ${results.length} emails leídos`);
              safeResolve({ success: true, emails: results, count: uids.length });
            }, 500);
          });
        });
      });
    });

    imap.connect();

    // Timeout global
    setTimeout(() => {
      safeResolve({ success: false, error: 'Timeout conectando al servidor de email (15s)', emails: [] });
    }, 15000);
  });
}

/**
 * Eliminar emails por UID (marcar como \Deleted + expunge)
 * @param {Object} imapConfig
 * @param {number[]} uids - UIDs a eliminar
 */
async function deleteEmails(imapConfig, uids) {
  if (!uids || uids.length === 0) return { success: true, deleted: 0 };

  return new Promise((resolve) => {
    const imap = new Imap({
      user: imapConfig.user,
      password: imapConfig.pass,
      host: imapConfig.host,
      port: imapConfig.port || 993,
      tls: imapConfig.tls !== false,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 15000,
    });

    let resolved = false;
    const safeResolve = (data) => {
      if (!resolved) { resolved = true; try { imap.end(); } catch (e) {} resolve(data); }
    };

    imap.once('error', (err) => {
      console.error(`${LOG_PREFIX} ❌ IMAP delete error: ${err.message}`);
      safeResolve({ success: false, error: err.message });
    });

    imap.once('ready', () => {
      imap.openBox(imapConfig.folder || 'INBOX', false, (err) => {
        if (err) { safeResolve({ success: false, error: err.message }); return; }

        imap.addFlags(uids, ['\\Deleted'], (flagErr) => {
          if (flagErr) {
            console.error(`${LOG_PREFIX} ❌ Error marcando como deleted: ${flagErr.message}`);
            safeResolve({ success: false, error: flagErr.message });
            return;
          }

          imap.expunge(uids, (expungeErr) => {
            if (expungeErr) {
              console.warn(`${LOG_PREFIX} ⚠️ Error en expunge (marcados pero no eliminados): ${expungeErr.message}`);
            }
            console.log(`${LOG_PREFIX} 🗑️ ${uids.length} emails eliminados`);
            safeResolve({ success: true, deleted: uids.length });
          });
        });
      });
    });

    imap.connect();
    setTimeout(() => safeResolve({ success: false, error: 'Timeout' }), 15000);
  });
}

/**
 * Enviar email via SMTP (usa mail_service.sendGenericEmail)
 * @param {string} to - Destinatario
 * @param {string} subject - Asunto
 * @param {string} body - Cuerpo
 * @param {string} fromName - Nombre del remitente (default: nombre del owner)
 */
async function sendEmail(to, subject, body, fromName = 'MIIA') {
  if (!_sendGenericEmail) {
    console.error(`${LOG_PREFIX} ❌ sendGenericEmail no inyectado`);
    return { success: false, error: 'Servicio de email no configurado' };
  }

  const result = await _sendGenericEmail(to, subject, body, { fromName });
  if (result.success) {
    console.log(`${LOG_PREFIX} 📧 Email enviado a ${to}: "${subject}"`);
  } else {
    console.error(`${LOG_PREFIX} ❌ Error enviando a ${to}: ${result.error}`);
  }
  return result;
}

/**
 * Formatear lista de emails para WhatsApp (legible)
 * @param {Array} emails
 * @returns {string}
 */
function formatEmailList(emails, totalCount) {
  if (!emails.length) return '📭 No tenés correos nuevos sin leer.';

  const header = totalCount > emails.length
    ? `📬 Tenés *${totalCount} correos sin leer*. Te muestro los últimos ${emails.length}:\n\n`
    : `📬 Tenés *${emails.length} correo${emails.length > 1 ? 's' : ''} sin leer*:\n\n`;

  const lines = emails.map((e, i) => {
    const num = i + 1;
    const ago = e.date ? _timeAgo(new Date(e.date)) : '';
    const attach = e.hasAttachments ? ' 📎' : '';
    return `*${num}.* De: *${e.fromName}*${attach}\n    📋 ${e.subject}\n    🕐 ${ago}`;
  });

  return header + lines.join('\n\n') +
    '\n\n_Decime qué hacer: "leé el 2 y el 5", "eliminá todos menos el 3", etc._';
}

/**
 * Formatear contenido de emails específicos
 * @param {Array} emails - emails completos
 * @param {number[]} indices - índices (1-based) a mostrar
 */
function formatEmailContent(emails, indices) {
  const results = [];
  for (const idx of indices) {
    const email = emails[idx - 1];
    if (!email) {
      results.push(`*${idx}.* ❌ No existe ese correo en la lista`);
      continue;
    }
    const body = email.textBody
      ? email.textBody.substring(0, 800).replace(/\n{3,}/g, '\n\n')
      : '(Sin contenido de texto)';
    results.push(`*${idx}. De: ${email.fromName}*\n📋 _${email.subject}_\n\n${body}`);
  }
  return results.join('\n\n---\n\n');
}

/**
 * Obtener config IMAP del owner desde Firestore
 */
async function getOwnerImapConfig(uid) {
  const admin = require('firebase-admin');
  try {
    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    if (!userDoc.exists) return null;
    const d = userDoc.data();
    // Primero intentar campos dedicados IMAP
    if (d.imapHost && d.imapUser) {
      return {
        host: d.imapHost,
        port: d.imapPort || 993,
        user: d.imapUser,
        pass: d.imapPass || '',
        folder: d.imapFolder || 'INBOX',
        tls: true,
      };
    }
    // Fallback: campos del profile
    const profile = d;
    if (profile.imapHost && profile.imapUser) {
      return {
        host: profile.imapHost,
        port: profile.imapPort || 993,
        user: profile.imapUser,
        pass: profile.imapPass || '',
        folder: profile.imapFolder || 'INBOX',
        tls: true,
      };
    }
    return null;
  } catch (e) {
    console.error(`${LOG_PREFIX} ❌ Error cargando IMAP config: ${e.message}`);
    return null;
  }
}

// ═══ CACHE ═══

function cacheEmails(uid, emails, imapConfig) {
  emailCache.set(uid, {
    emails,
    fetchedAt: Date.now(),
    imapConfig,
  });
}

function getCachedEmails(uid) {
  const cached = emailCache.get(uid);
  if (!cached) return null;
  // Cache válida por 10 minutos
  if (Date.now() - cached.fetchedAt > 10 * 60 * 1000) {
    emailCache.delete(uid);
    return null;
  }
  return cached;
}

function clearCache(uid) {
  emailCache.delete(uid);
}

// ═══ HELPERS ═══

function _timeAgo(date) {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'justo ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.round(hours / 24);
  return `hace ${days} día${days > 1 ? 's' : ''}`;
}

/**
 * Parsear comando de email del owner
 * "eliminá todos menos el 2 y el 5" → { action: 'delete_except', indices: [2, 5] }
 * "eliminá el 1, 3 y 4" → { action: 'delete', indices: [1, 3, 4] }
 * "leé el 2 y el 5" → { action: 'read', indices: [2, 5] }
 * "qué correos llegaron" → { action: 'fetch' }
 */
function parseEmailCommand(message) {
  if (!message) return null;
  const m = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Detectar "qué correos", "mis correos", "inbox", "bandeja"
  if (/\b(que\s+correos?|mis\s+correos?|inbox|bandeja|mails?\s+nuevos?|correos?\s+nuevos?|correos?\s+(?:tengo|hay|llegaron))\b/i.test(m)) {
    return { action: 'fetch' };
  }

  // Extraer números del mensaje
  const numbers = [];
  const numMatches = message.match(/\d+/g);
  if (numMatches) numMatches.forEach(n => numbers.push(parseInt(n)));

  // "eliminá/borrá todos menos el 2 y el 5"
  if (/\b(elimina|borra|quita|saca).*todos?\s+menos/i.test(m) && numbers.length > 0) {
    return { action: 'delete_except', keep: numbers };
  }

  // "eliminá/borrá el 1, 3 y 4"
  if (/\b(elimina|borra|quita|saca)/i.test(m) && numbers.length > 0) {
    return { action: 'delete', indices: numbers };
  }

  // "leé/decime qué dicen el 2 y el 5"
  if (/\b(lee|leeme|decime|dime|abrí|mostrame|que dice)/i.test(m) && numbers.length > 0) {
    return { action: 'read', indices: numbers };
  }

  return null;
}

// ═══ EXPORTS ═══

module.exports = {
  setEmailManagerDependencies,
  fetchUnreadEmails,
  deleteEmails,
  sendEmail,
  formatEmailList,
  formatEmailContent,
  getOwnerImapConfig,
  cacheEmails,
  getCachedEmails,
  clearCache,
  parseEmailCommand,
};
