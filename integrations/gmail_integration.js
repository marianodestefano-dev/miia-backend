'use strict';

/**
 * GMAIL INTEGRATION v1.0 — MIIA lee, clasifica y gestiona emails del owner
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * FUNCIONES:
 *   1. Leer emails no leídos → clasificar (importante/publicidad/spam/esperando_respuesta/dudoso)
 *   2. Reportar resumen al owner en self-chat
 *   3. Spam → auto-bloquear sender + mover a trash
 *   4. Dudoso → informar al owner con detalle para que decida
 *   5. "Esperando respuesta" → trackear y avisar cuando llegue
 *   6. Bajo demanda: "MIIA, ¿tengo mails?" → resumen inmediato
 *
 * SCOPES REQUERIDOS:
 *   - https://www.googleapis.com/auth/gmail.readonly (leer)
 *   - https://www.googleapis.com/auth/gmail.modify (labels, mark read, trash)
 *
 * FIRESTORE:
 *   users/{uid}/miia_gmail/config → { enabled, checkInterval, lastCheck, trackedThreads }
 *   users/{uid}/miia_gmail/tracked_responses/{threadId} → { subject, from, waitingSince, resolved }
 *
 * COSTO: $0 (Gmail API free, 250 quota units/user/sec)
 */

const { google } = require('googleapis');

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

const GMAIL_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutos
const MAX_EMAILS_PER_CHECK = 20;
const SPAM_AUTO_DELETE = true;

// Patrones para clasificar emails
const SPAM_PATTERNS = [
  /unsubscribe.*click/i,
  /you('ve| have) won/i,
  /ganaste|ganador|premio.*gratis/i,
  /act now|limited time|urgent.*offer/i,
  /viagra|cialis|enlarge/i,
  /crypto.*opportunity|bitcoin.*invest/i,
  /nigerian?.*prince/i,
  /lottery.*winner/i,
  /make money fast/i,
  /click here to claim/i,
  /millones?\s+de\s+(d[oó]lares|euros|pesos)/i,
];

const PROMO_PATTERNS = [
  /% off|% de descuento|% dto/i,
  /sale\b|oferta\b|promo\b|promoci[oó]n/i,
  /free shipping|env[ií]o gratis/i,
  /newsletter|bolet[ií]n/i,
  /unsuscri|unsubscri|darse de baja|cancelar suscripci/i,
  /\bdeals?\b|\bofertas?\b/i,
  /black friday|cyber monday|hot sale/i,
  /new arrivals|nuevos lanzamientos/i,
  /do-not-reply|no-reply|noreply/i,
];

const IMPORTANT_SENDER_PATTERNS = [
  /google\.com$/i,          // Google (Workspace, billing, etc.)
  /apple\.com$/i,           // Apple
  /stripe\.com$/i,          // Pagos
  /paddle\.com$/i,          // Pagos
  /mercadopago/i,           // Pagos LATAM
  /railway\.app$/i,         // Hosting
  /github\.com$/i,          // Código
  /firebase\.google\.com/i, // Firebase
  /banco|bank|banc/i,       // Bancos
  /afip|sat|dian|sii|sunat/i, // Impuestos LATAM
];

// ═══════════════════════════════════════════════════════════════
// GMAIL CLIENT HELPER
// ═══════════════════════════════════════════════════════════════

/**
 * Obtener cliente Gmail autenticado para un usuario
 * Reutiliza los googleTokens del Calendar (misma auth)
 * @param {string} uid
 * @param {Function} getOAuth2Client - Función del server.js
 * @returns {Promise<{gmail: object, userEmail: string}>}
 */
async function getGmailClient(uid, getOAuth2Client) {
  const admin = require('firebase-admin');
  const doc = await admin.firestore().collection('users').doc(uid).get();
  const data = doc.exists ? doc.data() : {};

  if (!data.googleTokens) {
    throw new Error('Google no conectado. El owner debe autorizar desde el Dashboard (Conexiones → Google).');
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(data.googleTokens);

  // Auto-refresh
  oauth2Client.on('tokens', async (tokens) => {
    const updated = { ...data.googleTokens, ...tokens };
    await admin.firestore().collection('users').doc(uid).set({ googleTokens: updated }, { merge: true });
    console.log(`[GMAIL] 🔄 Token refrescado para uid=${uid.substring(0, 8)}`);
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Obtener email del owner
  let userEmail = data.email || '';
  if (!userEmail) {
    try {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      userEmail = profile.data.emailAddress || '';
    } catch (e) {
      console.warn(`[GMAIL] ⚠️ No se pudo obtener email del perfil: ${e.message}`);
    }
  }

  return { gmail, userEmail };
}

// ═══════════════════════════════════════════════════════════════
// CLASIFICACIÓN DE EMAILS
// ═══════════════════════════════════════════════════════════════

/**
 * Clasificar un email en categorías
 * @param {object} email - { from, subject, snippet, labels, headers }
 * @returns {{ category: string, confidence: number, reason: string }}
 *
 * Categorías:
 *   - 'spam' → auto-eliminar
 *   - 'promo' → publicidad/marketing
 *   - 'important' → requiere atención (bancos, servicios, etc.)
 *   - 'awaiting_response' → email que el owner envió y espera respuesta
 *   - 'personal' → email de persona real (no automatizado)
 *   - 'doubtful' → no estoy segura, preguntar al owner
 */
function classifyEmail(email) {
  const { from, subject, snippet, labels } = email;
  const fullText = `${from} ${subject} ${snippet}`.toLowerCase();

  // SPAM check
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(fullText)) {
      return { category: 'spam', confidence: 0.9, reason: `Patrón spam detectado: ${pattern.source.substring(0, 30)}` };
    }
  }

  // Gmail ya lo marcó como spam
  if (labels && labels.includes('SPAM')) {
    return { category: 'spam', confidence: 0.95, reason: 'Gmail lo clasificó como SPAM' };
  }

  // Promo check
  let promoScore = 0;
  for (const pattern of PROMO_PATTERNS) {
    if (pattern.test(fullText)) promoScore++;
  }
  if (promoScore >= 2) {
    return { category: 'promo', confidence: 0.85, reason: `${promoScore} patrones de publicidad detectados` };
  }
  if (labels && (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_UPDATES'))) {
    return { category: 'promo', confidence: 0.8, reason: 'Gmail lo clasificó como promoción/actualización' };
  }

  // Important check (servicios críticos)
  const fromEmail = extractEmail(from);
  const fromDomain = fromEmail.split('@')[1] || '';
  for (const pattern of IMPORTANT_SENDER_PATTERNS) {
    if (pattern.test(fromDomain) || pattern.test(from)) {
      return { category: 'important', confidence: 0.9, reason: `Sender importante: ${fromDomain}` };
    }
  }

  // Personal check — si el from tiene nombre real y no es noreply
  if (!/noreply|no-reply|donotreply|mailer-daemon/i.test(from)) {
    const hasPersonName = /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ]/u.test(from);
    if (hasPersonName) {
      return { category: 'personal', confidence: 0.7, reason: 'Parece email de persona real' };
    }
  }

  // Si tiene label IMPORTANT de Gmail
  if (labels && labels.includes('IMPORTANT')) {
    return { category: 'important', confidence: 0.75, reason: 'Gmail lo marcó como importante' };
  }

  // Si nada matchea → dudoso
  return { category: 'doubtful', confidence: 0.5, reason: 'No pude clasificarlo con certeza' };
}

/**
 * Extraer email de un string "Name <email@example.com>"
 */
function extractEmail(fromStr) {
  const match = (fromStr || '').match(/<([^>]+)>/);
  return match ? match[1] : fromStr || '';
}

/**
 * Extraer nombre de un string "Name <email@example.com>"
 */
function extractName(fromStr) {
  const match = (fromStr || '').match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : (fromStr || '').split('@')[0];
}

// ═══════════════════════════════════════════════════════════════
// LEER EMAILS NO LEÍDOS
// ═══════════════════════════════════════════════════════════════

/**
 * Obtener emails no leídos y clasificarlos
 * @param {string} uid
 * @param {Function} getOAuth2Client
 * @param {object} opts - { maxResults, includeSpam }
 * @returns {Promise<{emails: object[], summary: object, error: string|null}>}
 */
async function getUnreadEmails(uid, getOAuth2Client, opts = {}) {
  const { maxResults = MAX_EMAILS_PER_CHECK, includeSpam = false } = opts;

  try {
    const { gmail, userEmail } = await getGmailClient(uid, getOAuth2Client);
    console.log(`[GMAIL] 📬 Leyendo emails no leídos para ${userEmail || uid.substring(0, 8)}...`);

    // Buscar no leídos en INBOX (excluir spam y trash por default)
    const query = includeSpam ? 'is:unread' : 'is:unread -in:spam -in:trash';
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messageIds = (listRes.data.messages || []).map(m => m.id);
    if (messageIds.length === 0) {
      console.log(`[GMAIL] ✅ No hay emails sin leer`);
      return { emails: [], summary: { total: 0 }, error: null };
    }

    console.log(`[GMAIL] 📨 ${messageIds.length} emails sin leer, procesando...`);

    // Obtener detalles de cada email
    const emails = [];
    for (const msgId of messageIds) {
      try {
        const msgRes = await gmail.users.messages.get({
          userId: 'me',
          id: msgId,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date', 'To', 'Reply-To'],
        });

        const headers = {};
        for (const h of (msgRes.data.payload?.headers || [])) {
          headers[h.name.toLowerCase()] = h.value;
        }

        const email = {
          id: msgId,
          threadId: msgRes.data.threadId,
          from: headers.from || '(desconocido)',
          to: headers.to || '',
          subject: headers.subject || '(sin asunto)',
          date: headers.date || '',
          snippet: msgRes.data.snippet || '',
          labels: msgRes.data.labelIds || [],
          internalDate: msgRes.data.internalDate,
        };

        // Clasificar
        email.classification = classifyEmail(email);
        emails.push(email);

      } catch (msgErr) {
        console.warn(`[GMAIL] ⚠️ Error leyendo email ${msgId}: ${msgErr.message}`);
      }
    }

    // Generar resumen por categoría
    const summary = {
      total: emails.length,
      important: emails.filter(e => e.classification.category === 'important').length,
      personal: emails.filter(e => e.classification.category === 'personal').length,
      promo: emails.filter(e => e.classification.category === 'promo').length,
      spam: emails.filter(e => e.classification.category === 'spam').length,
      doubtful: emails.filter(e => e.classification.category === 'doubtful').length,
    };

    console.log(`[GMAIL] 📊 Resumen: ${summary.important} importantes, ${summary.personal} personales, ${summary.promo} promos, ${summary.spam} spam, ${summary.doubtful} dudosos`);

    return { emails, summary, error: null };

  } catch (err) {
    console.error(`[GMAIL] ❌ Error leyendo emails: ${err.message}`);
    return { emails: [], summary: { total: 0 }, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// ACCIONES SOBRE EMAILS
// ═══════════════════════════════════════════════════════════════

/**
 * Mover emails spam a trash y bloquear sender
 * @param {string} uid
 * @param {Function} getOAuth2Client
 * @param {object[]} spamEmails - Emails clasificados como spam
 * @returns {Promise<{deleted: number, errors: number}>}
 */
async function handleSpamEmails(uid, getOAuth2Client, spamEmails) {
  if (!spamEmails || spamEmails.length === 0) return { deleted: 0, errors: 0 };

  try {
    const { gmail } = await getGmailClient(uid, getOAuth2Client);
    let deleted = 0;
    let errors = 0;

    for (const email of spamEmails) {
      try {
        // Mover a trash
        await gmail.users.messages.trash({
          userId: 'me',
          id: email.id,
        });
        deleted++;
        console.log(`[GMAIL:SPAM] 🗑️ Eliminado: "${email.subject}" de ${extractName(email.from)}`);

        // Crear filtro para bloquear sender (si no es noreply genérico)
        const senderEmail = extractEmail(email.from);
        if (senderEmail && !/noreply|no-reply/i.test(senderEmail)) {
          try {
            await gmail.users.settings.filters.create({
              userId: 'me',
              requestBody: {
                criteria: { from: senderEmail },
                action: { removeLabelIds: ['INBOX'], addLabelIds: ['TRASH'] },
              },
            });
            console.log(`[GMAIL:SPAM] 🚫 Sender bloqueado: ${senderEmail}`);
          } catch (filterErr) {
            // No es crítico si falla el filtro
            console.warn(`[GMAIL:SPAM] ⚠️ No se pudo crear filtro para ${senderEmail}: ${filterErr.message}`);
          }
        }
      } catch (delErr) {
        errors++;
        console.warn(`[GMAIL:SPAM] ⚠️ Error eliminando email ${email.id}: ${delErr.message}`);
      }
    }

    console.log(`[GMAIL:SPAM] ✅ ${deleted} spam eliminados, ${errors} errores`);
    return { deleted, errors };
  } catch (err) {
    console.error(`[GMAIL:SPAM] ❌ Error general: ${err.message}`);
    return { deleted: 0, errors: spamEmails.length };
  }
}

/**
 * Marcar emails como leídos
 * @param {string} uid
 * @param {Function} getOAuth2Client
 * @param {string[]} messageIds
 */
async function markAsRead(uid, getOAuth2Client, messageIds) {
  if (!messageIds || messageIds.length === 0) return;

  try {
    const { gmail } = await getGmailClient(uid, getOAuth2Client);
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: messageIds,
        removeLabelIds: ['UNREAD'],
      },
    });
    console.log(`[GMAIL] ✅ ${messageIds.length} emails marcados como leídos`);
  } catch (err) {
    console.error(`[GMAIL] ❌ Error marcando como leídos: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// TRACKING DE RESPUESTAS ESPERADAS
// ═══════════════════════════════════════════════════════════════

/**
 * Registrar que el owner está esperando respuesta de un thread
 * @param {string} uid
 * @param {string} threadId
 * @param {string} subject
 * @param {string} to - A quién le escribió
 */
async function trackAwaitingResponse(uid, threadId, subject, to) {
  const admin = require('firebase-admin');
  try {
    await admin.firestore()
      .collection('users').doc(uid)
      .collection('miia_gmail').doc('tracked_responses')
      .collection('threads').doc(threadId)
      .set({
        subject,
        to,
        waitingSince: new Date().toISOString(),
        resolved: false,
        notified: false,
      });
    console.log(`[GMAIL:TRACK] 📌 Trackeando respuesta de ${to}: "${subject}"`);
  } catch (err) {
    console.error(`[GMAIL:TRACK] ❌ Error registrando tracking: ${err.message}`);
  }
}

/**
 * Verificar si llegaron respuestas a threads trackeados
 * @param {string} uid
 * @param {Function} getOAuth2Client
 * @returns {Promise<object[]>} - Threads que recibieron respuesta
 */
async function checkTrackedResponses(uid, getOAuth2Client) {
  const admin = require('firebase-admin');
  const resolved = [];

  try {
    const trackedSnap = await admin.firestore()
      .collection('users').doc(uid)
      .collection('miia_gmail').doc('tracked_responses')
      .collection('threads')
      .where('resolved', '==', false)
      .limit(20)
      .get();

    if (trackedSnap.empty) return resolved;

    const { gmail } = await getGmailClient(uid, getOAuth2Client);

    for (const doc of trackedSnap.docs) {
      const data = doc.data();
      try {
        // Ver si el thread tiene mensajes nuevos
        const threadRes = await gmail.users.threads.get({
          userId: 'me',
          id: doc.id,
          format: 'metadata',
          metadataHeaders: ['From', 'Date'],
        });

        const messages = threadRes.data.messages || [];
        const lastMsg = messages[messages.length - 1];
        const lastFrom = lastMsg?.payload?.headers?.find(h => h.name.toLowerCase() === 'from')?.value || '';
        const lastDate = lastMsg?.payload?.headers?.find(h => h.name.toLowerCase() === 'date')?.value || '';

        // Si el último mensaje NO es del owner → recibió respuesta
        const waitingSince = new Date(data.waitingSince);
        const msgDate = new Date(lastDate);
        if (msgDate > waitingSince && messages.length > 1) {
          resolved.push({
            threadId: doc.id,
            subject: data.subject,
            from: extractName(lastFrom),
            fromEmail: extractEmail(lastFrom),
            to: data.to,
            waitingSince: data.waitingSince,
            respondedAt: lastDate,
          });

          // Marcar como resuelto
          await doc.ref.update({ resolved: true, resolvedAt: new Date().toISOString() });
          console.log(`[GMAIL:TRACK] ✅ Respuesta recibida: "${data.subject}" de ${extractName(lastFrom)}`);
        }
      } catch (threadErr) {
        console.warn(`[GMAIL:TRACK] ⚠️ Error verificando thread ${doc.id}: ${threadErr.message}`);
      }
    }

    return resolved;
  } catch (err) {
    console.error(`[GMAIL:TRACK] ❌ Error general: ${err.message}`);
    return resolved;
  }
}

// ═══════════════════════════════════════════════════════════════
// FORMATEO PARA WHATSAPP (SELF-CHAT)
// ═══════════════════════════════════════════════════════════════

/**
 * Formatear resumen de emails para self-chat de WhatsApp
 * @param {object[]} emails - Emails clasificados
 * @param {object} summary - Resumen por categoría
 * @param {object} spamResult - Resultado de eliminación de spam
 * @param {object[]} newResponses - Respuestas recibidas a threads trackeados
 * @returns {string}
 */
function formatEmailSummary(emails, summary, spamResult, newResponses) {
  if (summary.total === 0 && (!newResponses || newResponses.length === 0)) {
    return `📬 No tenés emails sin leer. Todo al día.`;
  }

  let msg = `📬 *Resumen de emails* (${summary.total} sin leer)\n\n`;

  // Respuestas esperadas que llegaron
  if (newResponses && newResponses.length > 0) {
    msg += `📩 *Respuestas que esperabas:*\n`;
    for (const r of newResponses) {
      msg += `  ✅ ${r.from} respondió "${r.subject}"\n`;
    }
    msg += '\n';
  }

  // Importantes
  const important = emails.filter(e => e.classification.category === 'important');
  if (important.length > 0) {
    msg += `🔴 *Importantes (${important.length}):*\n`;
    for (const e of important.slice(0, 5)) {
      msg += `  • ${extractName(e.from)}: "${e.subject}"\n`;
    }
    if (important.length > 5) msg += `  ... y ${important.length - 5} más\n`;
    msg += '\n';
  }

  // Personales
  const personal = emails.filter(e => e.classification.category === 'personal');
  if (personal.length > 0) {
    msg += `👤 *Personales (${personal.length}):*\n`;
    for (const e of personal.slice(0, 5)) {
      msg += `  • ${extractName(e.from)}: "${e.subject}"\n`;
    }
    if (personal.length > 5) msg += `  ... y ${personal.length - 5} más\n`;
    msg += '\n';
  }

  // Dudosos
  const doubtful = emails.filter(e => e.classification.category === 'doubtful');
  if (doubtful.length > 0) {
    msg += `❓ *Tengo dudas con ${doubtful.length === 1 ? 'este' : 'estos'} (${doubtful.length}):*\n`;
    for (const e of doubtful.slice(0, 3)) {
      msg += `  • ${extractName(e.from)}: "${e.subject}" — ¿Lo elimino o lo dejo?\n`;
    }
    msg += '\n';
  }

  // Publicidad
  if (summary.promo > 0) {
    msg += `📢 Publicidad: ${summary.promo} emails\n`;
  }

  // Spam eliminado
  if (spamResult && spamResult.deleted > 0) {
    msg += `🗑️ Spam eliminado: ${spamResult.deleted} emails basura borrados automáticamente\n`;
  }

  return msg.trim();
}

// ═══════════════════════════════════════════════════════════════
// CLASIFICACIÓN CON IA (para dudosos o análisis profundo)
// ═══════════════════════════════════════════════════════════════

/**
 * Usar Gemini para clasificar emails dudosos con más precisión
 * @param {object[]} emails - Emails dudosos
 * @param {Function} generateAI - Función de generación IA
 * @param {object} ownerContext - { name, businesses }
 * @returns {Promise<object[]>} - Emails con clasificación mejorada
 */
async function classifyWithAI(emails, generateAI, ownerContext) {
  if (!generateAI || emails.length === 0) return emails;

  try {
    const emailsList = emails.map((e, i) =>
      `${i + 1}. De: ${e.from} | Asunto: "${e.subject}" | Preview: "${e.snippet.substring(0, 100)}"`
    ).join('\n');

    const prompt = `Clasificá estos emails para ${ownerContext?.name || 'el usuario'}${ownerContext?.businesses ? ` (tiene negocios: ${ownerContext.businesses.join(', ')})` : ''}.

EMAILS:
${emailsList}

Para cada email respondé con JSON:
[{"index":1,"category":"important|personal|promo|spam|awaiting","reason":"explicación corta"}]

Criterios:
- "important": de servicios, bancos, gobierno, o que requiere acción urgente
- "personal": de una persona real que espera respuesta
- "promo": marketing, newsletters, ofertas
- "spam": basura, scam, phishing
- "awaiting": parece respuesta a algo que el usuario envió antes
Respondé SOLO el JSON.`;

    const response = await generateAI(prompt);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const classifications = JSON.parse(jsonMatch[0]);
      for (const c of classifications) {
        const idx = (c.index || 0) - 1;
        if (idx >= 0 && idx < emails.length) {
          emails[idx].classification = {
            category: c.category || 'doubtful',
            confidence: 0.85,
            reason: c.reason || 'Clasificado por IA',
          };
        }
      }
      console.log(`[GMAIL:AI] 🤖 ${classifications.length} emails reclasificados por IA`);
    }
  } catch (err) {
    console.warn(`[GMAIL:AI] ⚠️ Error en clasificación IA: ${err.message}`);
  }

  return emails;
}

// ═══════════════════════════════════════════════════════════════
// DETECCIÓN DE COMANDOS EN SELF-CHAT
// ═══════════════════════════════════════════════════════════════

/**
 * Detectar si el mensaje del owner es un comando de Gmail
 * @param {string} message
 * @returns {{ isGmail: boolean, type: string }}
 *
 * Tipos:
 *   - 'check' → "¿tengo mails?" / "revisá mi correo"
 *   - 'detail' → "qué dice el mail de X"
 *   - 'delete_spam' → "borrá el spam"
 *   - 'track' → "avisame cuando X me responda"
 */
function detectGmailCommand(message) {
  if (!message) return { isGmail: false, type: 'none' };

  const msg = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Check emails
  if (/\b(tengo\s+mails?|tengo\s+correos?|revis[aá]\s+mi\s+correo|mi\s+mail|mails?\s+sin\s+leer|correos?\s+sin\s+leer|cheque[aá]\s+mi\s+email|inbox|bandeja\s+de\s+entrada|mails?\s+nuevos?)\b/i.test(msg)) {
    return { isGmail: true, type: 'check' };
  }

  // Delete spam
  if (/\b(borr[aá]\s+(?:el\s+)?spam|elimin[aá]\s+(?:el\s+)?spam|limpi[aá]\s+(?:el\s+)?correo|limpi[aá]\s+(?:mi\s+)?inbox)\b/i.test(msg)) {
    return { isGmail: true, type: 'delete_spam' };
  }

  // Track response
  if (/\b(avisame\s+cuando.*(?:respond|conteste)|espero\s+respuesta\s+de|esperando\s+(?:un\s+)?mail\s+de)\b/i.test(msg)) {
    return { isGmail: true, type: 'track' };
  }

  return { isGmail: false, type: 'none' };
}

// ═══════════════════════════════════════════════════════════════
// PROCESO COMPLETO DE CHECK
// ═══════════════════════════════════════════════════════════════

/**
 * Ejecuta el check completo de emails:
 * 1. Leer no leídos
 * 2. Clasificar (regex + IA para dudosos)
 * 3. Eliminar spam automáticamente
 * 4. Verificar respuestas trackeadas
 * 5. Formatear resumen
 *
 * @param {string} uid
 * @param {Function} getOAuth2Client
 * @param {object} opts - { generateAI, ownerContext, autoDeleteSpam }
 * @returns {Promise<{message: string, summary: object, error: string|null}>}
 */
async function runFullEmailCheck(uid, getOAuth2Client, opts = {}) {
  const { generateAI, ownerContext, autoDeleteSpam = SPAM_AUTO_DELETE } = opts;

  console.log(`[GMAIL] 🔍 Iniciando check completo de emails para uid=${uid.substring(0, 8)}...`);

  // 1. Leer emails no leídos
  const { emails, summary, error } = await getUnreadEmails(uid, getOAuth2Client);
  if (error) {
    return { message: `❌ No pude acceder a tu correo: ${error}`, summary: { total: 0 }, error };
  }

  // 2. Clasificar dudosos con IA (si hay generateAI disponible)
  const doubtful = emails.filter(e => e.classification.category === 'doubtful');
  if (doubtful.length > 0 && generateAI) {
    await classifyWithAI(doubtful, generateAI, ownerContext);
    // Actualizar summary después de reclasificación
    summary.important = emails.filter(e => e.classification.category === 'important').length;
    summary.personal = emails.filter(e => e.classification.category === 'personal').length;
    summary.promo = emails.filter(e => e.classification.category === 'promo').length;
    summary.spam = emails.filter(e => e.classification.category === 'spam').length;
    summary.doubtful = emails.filter(e => e.classification.category === 'doubtful').length;
  }

  // 3. Eliminar spam automáticamente
  let spamResult = { deleted: 0, errors: 0 };
  if (autoDeleteSpam) {
    const spamEmails = emails.filter(e => e.classification.category === 'spam');
    if (spamEmails.length > 0) {
      spamResult = await handleSpamEmails(uid, getOAuth2Client, spamEmails);
    }
  }

  // 4. Verificar respuestas trackeadas
  let newResponses = [];
  try {
    newResponses = await checkTrackedResponses(uid, getOAuth2Client);
  } catch (trackErr) {
    console.warn(`[GMAIL] ⚠️ Error verificando tracked responses: ${trackErr.message}`);
  }

  // 5. Formatear resumen
  const message = formatEmailSummary(emails, summary, spamResult, newResponses);

  // 6. Guardar estado del último check
  try {
    const admin = require('firebase-admin');
    await admin.firestore()
      .collection('users').doc(uid)
      .collection('miia_gmail').doc('config')
      .set({
        lastCheck: new Date().toISOString(),
        lastSummary: summary,
        enabled: true,
      }, { merge: true });
  } catch (stateErr) {
    console.warn(`[GMAIL] ⚠️ Error guardando estado: ${stateErr.message}`);
  }

  console.log(`[GMAIL] ✅ Check completo: ${summary.total} emails procesados`);
  return { message, summary, error: null };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Core
  getGmailClient,
  getUnreadEmails,
  runFullEmailCheck,

  // Acciones
  handleSpamEmails,
  markAsRead,
  trackAwaitingResponse,
  checkTrackedResponses,

  // Clasificación
  classifyEmail,
  classifyWithAI,

  // Detección
  detectGmailCommand,

  // Formateo
  formatEmailSummary,

  // Helpers
  extractEmail,
  extractName,

  // Constantes
  GMAIL_CHECK_INTERVAL_MS,
};
