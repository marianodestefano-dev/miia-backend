'use strict';

/**
 * INSTAGRAM_HANDLER.JS — Módulo de integración Instagram DMs para MIIA
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * FLUJO:
 *   1. Owner vincula su Instagram Business desde el Dashboard (OAuth2)
 *   2. Meta envía webhooks de DMs entrantes a /api/instagram/webhook
 *   3. Este handler procesa el mensaje, identifica al tenant, y genera respuesta IA
 *   4. La respuesta se envía via Instagram Messaging API
 *
 * ARQUITECTURA:
 *   - Cada tenant tiene su propio Instagram token en Firestore
 *   - Los mensajes de Instagram se procesan con el mismo prompt_builder que WhatsApp
 *   - El historial de conversaciones Instagram se guarda separado (prefijo "ig_")
 *
 * LIMITACIONES:
 *   - Ventana de 24h: solo se puede responder dentro de 24h del último mensaje del usuario
 *   - 250 conversaciones/24h en Standard Access
 *   - Requiere cuenta Business/Creator vinculada a Facebook Page
 */

const admin = require('firebase-admin');
const tokenEncryption = require('./token_encryption');

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

const IG_API_BASE = 'https://graph.instagram.com/v21.0';
const IG_GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const TOKEN_REFRESH_BUFFER_DAYS = 7; // Refrescar token 7 días antes de expirar

// Cache en memoria: igPageId → { uid, token, igUserId, pageId }
const tenantCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

// ═══════════════════════════════════════════════════════════════
// TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

/**
 * Obtener token de Instagram de un tenant desde Firestore
 * @param {string} uid - Firebase UID del owner
 * @returns {object|null} { accessToken, igUserId, pageId, pageAccessToken, expiresAt }
 */
async function getInstagramToken(uid) {
  try {
    const doc = await admin.firestore()
      .collection('users').doc(uid)
      .collection('integrations').doc('instagram')
      .get();

    if (!doc.exists) return null;
    const data = doc.data();

    // Desencriptar tokens si vienen encriptados
    if (data.accessToken) data.accessToken = tokenEncryption.decrypt(data.accessToken) || data.accessToken;
    if (data.pageAccessToken) data.pageAccessToken = tokenEncryption.decrypt(data.pageAccessToken) || data.pageAccessToken;

    // Verificar si el token necesita refresh
    if (data.expiresAt) {
      const expiresDate = new Date(data.expiresAt);
      const refreshDate = new Date(expiresDate.getTime() - TOKEN_REFRESH_BUFFER_DAYS * 86400000);
      if (new Date() >= refreshDate) {
        console.log(`[INSTAGRAM] 🔄 Token de ${uid.substring(0, 8)}... necesita refresh (expira ${expiresDate.toISOString()})`);
        const refreshed = await refreshLongLivedToken(uid, data.accessToken);
        if (refreshed) return refreshed;
      }
    }

    return data;
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error obteniendo token para ${uid.substring(0, 8)}...:`, err.message);
    return null;
  }
}

/**
 * Guardar token de Instagram en Firestore
 * @param {string} uid
 * @param {object} tokenData
 */
async function saveInstagramToken(uid, tokenData) {
  try {
    // Encriptar tokens antes de guardar
    const dataToSave = { ...tokenData };
    if (dataToSave.accessToken) dataToSave.accessToken = tokenEncryption.encrypt(dataToSave.accessToken);
    if (dataToSave.pageAccessToken) dataToSave.pageAccessToken = tokenEncryption.encrypt(dataToSave.pageAccessToken);

    await admin.firestore()
      .collection('users').doc(uid)
      .collection('integrations').doc('instagram')
      .set({
        ...dataToSave,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    console.log(`[INSTAGRAM] ✅ Token guardado para ${uid.substring(0, 8)}...`);

    // Invalidar cache
    tenantCache.delete(tokenData.igUserId);
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error guardando token para ${uid.substring(0, 8)}...:`, err.message);
    throw err;
  }
}

/**
 * Intercambiar code de OAuth por token de larga duración
 * @param {string} code - Authorization code del OAuth redirect
 * @param {string} redirectUri - URI de redirect configurada en la app
 * @param {string} appId - Facebook App ID
 * @param {string} appSecret - Facebook App Secret
 * @returns {object} { accessToken, igUserId, pageId, pageAccessToken, expiresAt }
 */
async function exchangeCodeForToken(code, redirectUri, appId, appSecret) {
  console.log(`[INSTAGRAM] 🔑 Intercambiando code por token...`);

  // Paso 1: Code → short-lived token
  const tokenUrl = `${IG_GRAPH_BASE}/oauth/access_token`;
  // T16-FIX HIGH-2: AbortSignal.timeout (CLAUDE.md §6.18)
  const tokenResp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code: code
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    throw new Error(`OAuth token exchange failed: ${err}`);
  }

  const tokenData = await tokenResp.json();
  const shortToken = tokenData.access_token;
  console.log(`[INSTAGRAM] ✅ Short-lived token obtenido`);

  // Paso 2: Short-lived → long-lived token (60 días)
  const longUrl = `${IG_GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`;
  const longResp = await fetch(longUrl, { signal: AbortSignal.timeout(15000) });

  if (!longResp.ok) {
    const err = await longResp.text();
    throw new Error(`Long-lived token exchange failed: ${err}`);
  }

  const longData = await longResp.json();
  const longToken = longData.access_token;
  const expiresIn = longData.expires_in || 5184000; // 60 días default
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  console.log(`[INSTAGRAM] ✅ Long-lived token obtenido (expira en ${Math.round(expiresIn / 86400)} días)`);

  // Paso 3: Obtener Instagram User ID y Page ID
  const meResp = await fetch(`${IG_GRAPH_BASE}/me/accounts?access_token=${longToken}`, { signal: AbortSignal.timeout(15000) });
  const meData = await meResp.json();
  const page = meData.data?.[0];

  if (!page) {
    throw new Error('No se encontró Facebook Page vinculada. El usuario necesita vincular una Page a su cuenta Instagram Business.');
  }

  const pageId = page.id;
  const pageAccessToken = page.access_token;

  // Paso 4: Obtener Instagram Business Account ID desde la Page
  const igResp = await fetch(`${IG_GRAPH_BASE}/${pageId}?fields=instagram_business_account&access_token=${pageAccessToken}`, { signal: AbortSignal.timeout(15000) });
  const igData = await igResp.json();
  const igUserId = igData.instagram_business_account?.id;

  if (!igUserId) {
    throw new Error('No se encontró cuenta Instagram Business vinculada a la Page. Verificá que tu Instagram sea Business/Creator y esté vinculada a la Facebook Page.');
  }

  console.log(`[INSTAGRAM] ✅ Instagram Business Account: ${igUserId}, Page: ${pageId}`);

  return {
    accessToken: longToken,
    pageAccessToken,
    igUserId,
    pageId,
    expiresAt,
    connectedAt: new Date().toISOString()
  };
}

/**
 * Refrescar long-lived token (antes de que expire)
 * @param {string} uid
 * @param {string} currentToken
 * @returns {object|null}
 */
async function refreshLongLivedToken(uid, currentToken) {
  try {
    const appId = process.env.INSTAGRAM_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    if (!appId || !appSecret) {
      console.warn('[INSTAGRAM] ⚠️ INSTAGRAM_APP_ID/SECRET no configurados — no se puede refrescar token');
      return null;
    }

    const url = `${IG_GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${currentToken}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });

    if (!resp.ok) {
      console.error(`[INSTAGRAM] ❌ Token refresh failed: ${await resp.text()}`);
      return null;
    }

    const data = await resp.json();
    const expiresIn = data.expires_in || 5184000;
    const tokenData = {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
    };

    await saveInstagramToken(uid, tokenData);
    console.log(`[INSTAGRAM] ✅ Token refrescado para ${uid.substring(0, 8)}... (nuevo vencimiento: ${tokenData.expiresAt})`);
    return tokenData;
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error refrescando token:`, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// TENANT LOOKUP — Encontrar qué tenant recibe el mensaje
// ═══════════════════════════════════════════════════════════════

/**
 * Buscar tenant por Instagram User ID (recipientId del webhook)
 * @param {string} igUserId
 * @returns {object|null} { uid, tokenData }
 */
async function findTenantByIgUserId(igUserId) {
  // Check cache
  const cached = tenantCache.get(igUserId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    // Query Firestore: buscar usuario con este igUserId
    const snapshot = await admin.firestore()
      .collectionGroup('integrations')
      .where('igUserId', '==', igUserId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.warn(`[INSTAGRAM] ⚠️ No se encontró tenant para igUserId=${igUserId}`);
      return null;
    }

    const doc = snapshot.docs[0];
    // Path: users/{uid}/integrations/instagram → extraer uid
    const uid = doc.ref.parent.parent.id;
    const tokenData = doc.data();

    const result = { uid, tokenData };
    tenantCache.set(igUserId, { data: result, ts: Date.now() });
    console.log(`[INSTAGRAM] 🔍 Tenant encontrado para igUserId=${igUserId}: ${uid.substring(0, 8)}...`);
    return result;
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error buscando tenant:`, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// ENVIAR MENSAJE — Instagram Messaging API
// ═══════════════════════════════════════════════════════════════

/**
 * Enviar mensaje de texto via Instagram DM
 * @param {string} recipientId - Instagram-scoped ID del destinatario
 * @param {string} text - Texto del mensaje
 * @param {string} pageAccessToken - Token de la página
 * @returns {boolean} success
 */
async function sendInstagramMessage(recipientId, text, pageAccessToken) {
  if (!text || !recipientId || !pageAccessToken) {
    console.error(`[INSTAGRAM] ❌ sendInstagramMessage: parámetros faltantes`);
    return false;
  }

  // Instagram limita mensajes a 1000 chars
  const maxLen = 1000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.substring(0, maxLen));
    remaining = remaining.substring(maxLen);
  }

  try {
    for (const chunk of chunks) {
      const resp = await fetch(`${IG_GRAPH_BASE}/me/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${pageAccessToken}`
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: chunk }
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error(`[INSTAGRAM] ❌ Error enviando DM a ${recipientId}: ${err}`);
        return false;
      }
    }

    console.log(`[INSTAGRAM] 📤 DM enviado a ${recipientId} (${chunks.length} chunk${chunks.length > 1 ? 's' : ''}, ${text.length} chars)`);
    return true;
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error enviando DM:`, err.message);
    return false;
  }
}

/**
 * Enviar imagen via Instagram DM
 * @param {string} recipientId
 * @param {string} imageUrl
 * @param {string} pageAccessToken
 * @returns {boolean}
 */
async function sendInstagramImage(recipientId, imageUrl, pageAccessToken) {
  try {
    const resp = await fetch(`${IG_GRAPH_BASE}/me/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pageAccessToken}`
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: 'image',
            payload: { url: imageUrl }
          }
        }
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[INSTAGRAM] ❌ Error enviando imagen a ${recipientId}: ${err}`);
      return false;
    }

    console.log(`[INSTAGRAM] 🖼️ Imagen enviada a ${recipientId}`);
    return true;
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error enviando imagen:`, err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK PROCESSING — Procesar mensajes entrantes
// ═══════════════════════════════════════════════════════════════

/**
 * Parsear webhook payload de Instagram
 * @param {object} body - Request body del webhook
 * @returns {object[]} Array de { senderId, recipientId, text, timestamp, messageId, isEcho }
 */
function parseWebhookMessages(body) {
  const messages = [];

  if (body.object !== 'instagram') return messages;

  for (const entry of (body.entry || [])) {
    for (const messaging of (entry.messaging || [])) {
      const senderId = messaging.sender?.id;
      const recipientId = messaging.recipient?.id;
      const timestamp = messaging.timestamp;

      // Mensaje de texto
      if (messaging.message) {
        const isEcho = messaging.message.is_echo || false;
        const text = messaging.message.text || '';
        const attachments = messaging.message.attachments || [];

        messages.push({
          senderId,
          recipientId,
          text,
          attachments,
          timestamp,
          messageId: messaging.message.mid,
          isEcho,
          type: 'message'
        });
      }

      // Postback (botones/quick replies)
      if (messaging.postback) {
        messages.push({
          senderId,
          recipientId,
          text: messaging.postback.payload || messaging.postback.title || '',
          timestamp,
          type: 'postback'
        });
      }
    }
  }

  return messages;
}

/**
 * Obtener info del perfil de Instagram de un usuario
 * @param {string} userId - Instagram-scoped user ID
 * @param {string} accessToken
 * @returns {object|null} { name, username, profilePic }
 */
async function getInstagramProfile(userId, accessToken) {
  try {
    const resp = await fetch(`${IG_GRAPH_BASE}/${userId}?fields=name,username,profile_pic&access_token=${accessToken}`, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      name: data.name || data.username || 'Usuario Instagram',
      username: data.username || '',
      profilePic: data.profile_pic || ''
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION HISTORY — Historial de conversaciones Instagram
// ═══════════════════════════════════════════════════════════════

/**
 * Guardar mensaje de Instagram en historial (Firestore)
 * @param {string} uid - Owner UID
 * @param {string} igContactId - Instagram-scoped contact ID
 * @param {string} role - 'user' | 'assistant'
 * @param {string} text
 */
async function saveIgMessage(uid, igContactId, role, text) {
  try {
    await admin.firestore()
      .collection('users').doc(uid)
      .collection('ig_conversations').doc(igContactId)
      .collection('messages')
      .add({
        role,
        content: text,
        timestamp: Date.now(),
        createdAt: new Date().toISOString()
      });
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error guardando mensaje:`, err.message);
  }
}

/**
 * Obtener historial de conversación de Instagram (últimos N mensajes)
 * @param {string} uid
 * @param {string} igContactId
 * @param {number} limit
 * @returns {object[]} [{ role, content, timestamp }]
 */
async function getIgConversationHistory(uid, igContactId, limit = 20) {
  try {
    const snap = await admin.firestore()
      .collection('users').doc(uid)
      .collection('ig_conversations').doc(igContactId)
      .collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map(d => d.data()).reverse();
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error leyendo historial:`, err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Token management
  getInstagramToken,
  saveInstagramToken,
  exchangeCodeForToken,
  refreshLongLivedToken,

  // Tenant lookup
  findTenantByIgUserId,

  // Messaging
  sendInstagramMessage,
  sendInstagramImage,

  // Webhook
  parseWebhookMessages,
  getInstagramProfile,

  // Conversation history
  saveIgMessage,
  getIgConversationHistory,

  // Constants
  IG_API_BASE,
  IG_GRAPH_BASE
};
