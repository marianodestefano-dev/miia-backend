'use strict';

/**
 * GOOGLE SERVICES INTEGRATION — Contacts, Drive, Places, YouTube, Business Profile.
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Servicios:
 *   1. Google Contacts — Leer/buscar contactos del owner
 *   2. Google Drive — Listar/buscar archivos, subir, compartir
 *   3. Google Places — Buscar negocios, detalles, reseñas
 *   4. YouTube — Buscar videos, info de canales, nuevos videos de suscripciones
 *   5. Google Business Profile — Info del negocio del owner (si tiene)
 *
 * Reutiliza OAuth de google_calendar.js (getOAuth2Client)
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

const { google } = require('googleapis');
const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════════
// HELPER: Obtener OAuth2 client (reutiliza google_calendar.js)
// ═══════════════════════════════════════════════════════════════

async function getAuthClient(uid) {
  const { getOAuth2Client } = require('./google_calendar_integration') || require('../google_calendar');
  let oauth2;
  try {
    const calModule = require('../google_calendar');
    oauth2 = await calModule.getOAuth2Client(uid);
  } catch {
    // Fallback: construir manualmente
    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    const tokens = userDoc.data()?.googleTokens;
    if (!tokens) throw new Error('Google no conectado — el owner debe vincular su cuenta');
    const { OAuth2 } = google.auth;
    oauth2 = new OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2.setCredentials(tokens);
    // Auto-refresh
    if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      await admin.firestore().collection('users').doc(uid).update({ googleTokens: credentials });
    }
  }
  return oauth2;
}

// ═══════════════════════════════════════════════════════════════
// 1. GOOGLE CONTACTS
// ═════════════════════════════════════════════════════���═════════

/**
 * Listar contactos del owner.
 */
async function listContacts(uid, query, limit = 20) {
  const auth = await getAuthClient(uid);
  const people = google.people({ version: 'v1', auth });

  if (query) {
    // Buscar contactos por nombre/email/teléfono
    const res = await people.people.searchContacts({
      query,
      readMask: 'names,emailAddresses,phoneNumbers,organizations',
      pageSize: limit,
    });
    const contacts = (res.data.results || []).map(r => formatContact(r.person));
    console.log(`[GOOGLE-CONTACTS] 🔍 Búsqueda "${query}": ${contacts.length} resultados`);
    return contacts;
  }

  // Listar todos
  const res = await people.people.connections.list({
    resourceName: 'people/me',
    personFields: 'names,emailAddresses,phoneNumbers,organizations',
    pageSize: limit,
    sortOrder: 'LAST_MODIFIED_DESCENDING',
  });
  const contacts = (res.data.connections || []).map(formatContact);
  console.log(`[GOOGLE-CONTACTS] 📋 ${contacts.length} contactos listados`);
  return contacts;
}

/**
 * Crear un contacto nuevo.
 */
async function createContact(uid, data) {
  const auth = await getAuthClient(uid);
  const people = google.people({ version: 'v1', auth });

  const requestBody = {
    names: [{ givenName: data.firstName || '', familyName: data.lastName || '' }],
  };
  if (data.email) requestBody.emailAddresses = [{ value: data.email }];
  if (data.phone) requestBody.phoneNumbers = [{ value: data.phone }];
  if (data.company) requestBody.organizations = [{ name: data.company }];

  const res = await people.people.createContact({ requestBody });
  console.log(`[GOOGLE-CONTACTS] ✅ Contacto creado: ${data.firstName} ${data.lastName}`);
  return formatContact(res.data);
}

function formatContact(person) {
  if (!person) return null;
  return {
    resourceName: person.resourceName,
    name: person.names?.[0]?.displayName || '',
    firstName: person.names?.[0]?.givenName || '',
    lastName: person.names?.[0]?.familyName || '',
    email: person.emailAddresses?.[0]?.value || '',
    phone: person.phoneNumbers?.[0]?.value || '',
    company: person.organizations?.[0]?.name || '',
  };
}

// ═══════════════════════════════════════════════════════════════
// 2. GOOGLE DRIVE
// ═══════════════════════════════════════════════════════════════

/**
 * Listar archivos recientes del Drive.
 */
async function listDriveFiles(uid, query, limit = 10) {
  const auth = await getAuthClient(uid);
  const drive = google.drive({ version: 'v3', auth });

  const params = {
    pageSize: limit,
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink)',
    orderBy: 'modifiedTime desc',
  };

  if (query) {
    params.q = `name contains '${query.replace(/'/g, "\\'")}'`;
  }

  const res = await drive.files.list(params);
  const files = (res.data.files || []).map(f => ({
    id: f.id,
    name: f.name,
    type: f.mimeType,
    size: f.size ? `${Math.round(parseInt(f.size) / 1024)}KB` : '',
    modified: f.modifiedTime,
    url: f.webViewLink,
  }));

  console.log(`[GOOGLE-DRIVE] 📁 ${files.length} archivos${query ? ` (búsqueda: "${query}")` : ''}`);
  return files;
}

/**
 * Subir archivo al Drive.
 */
async function uploadToDrive(uid, fileName, content, mimeType = 'text/plain') {
  const auth = await getAuthClient(uid);
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.create({
    requestBody: { name: fileName, mimeType },
    media: { mimeType, body: content },
    fields: 'id,name,webViewLink',
  });

  console.log(`[GOOGLE-DRIVE] ✅ Archivo subido: ${fileName} → ${res.data.id}`);
  return { fileId: res.data.id, name: res.data.name, url: res.data.webViewLink };
}

/**
 * Compartir archivo del Drive.
 */
async function shareDriveFile(uid, fileId, email, role = 'reader') {
  const auth = await getAuthClient(uid);
  const drive = google.drive({ version: 'v3', auth });

  await drive.permissions.create({
    fileId,
    requestBody: { type: 'user', role, emailAddress: email },
  });

  console.log(`[GOOGLE-DRIVE] 🔗 Archivo ${fileId} compartido con ${email} (${role})`);
  return { shared: true, email, role };
}

// ═══════════════════════════════════════════════════════════════
// 3. GOOGLE PLACES (via Gemini google_search — gratis)
// ═══════════════════════════════════════════════════════════════

/**
 * Buscar lugares/negocios cercanos (usa Gemini google_search).
 */
async function searchPlaces(query, location, aiGateway) {
  const searchPrompt = `Buscar "${query}" ${location ? `cerca de ${location}` : ''}.
Devolvé JSON array con máx 5 resultados. Cada objeto:
{ "name": "", "address": "", "phone": "", "rating": 0, "hours": "", "type": "", "priceLevel": "", "url": "" }
SOLO JSON, sin texto adicional.`;

  try {
    const result = await aiGateway.smartCall(
      aiGateway.CONTEXTS?.GENERAL || 'general',
      searchPrompt, {}, { enableSearch: true }
    );
    const jsonMatch = (result?.text || '').match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const places = JSON.parse(jsonMatch[0]);
      console.log(`[GOOGLE-PLACES] 📍 ${places.length} lugares encontrados para "${query}"`);
      return places.slice(0, 5);
    }
    console.warn(`[GOOGLE-PLACES] ⚠️ No JSON parseable para "${query}"`);
    return [];
  } catch (err) {
    console.error(`[GOOGLE-PLACES] ❌ Error:`, err.message);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. YOUTUBE
// ═══════════════════════════════════════════════════════════════

/**
 * Buscar videos en YouTube.
 */
async function searchYouTube(query, limit = 5) {
  const youtube = google.youtube({ version: 'v3', auth: process.env.GOOGLE_API_KEY || process.env.YOUTUBE_API_KEY });

  const res = await youtube.search.list({
    q: query,
    part: 'snippet',
    type: 'video',
    maxResults: limit,
    order: 'relevance',
  });

  const videos = (res.data.items || []).map(item => ({
    videoId: item.id?.videoId,
    title: item.snippet?.title,
    channel: item.snippet?.channelTitle,
    description: (item.snippet?.description || '').substring(0, 200),
    thumbnail: item.snippet?.thumbnails?.default?.url,
    publishedAt: item.snippet?.publishedAt,
    url: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
  }));

  console.log(`[YOUTUBE] 🎬 ${videos.length} videos encontrados para "${query}"`);
  return videos;
}

/**
 * Obtener info de un canal de YouTube.
 */
async function getChannelInfo(channelId) {
  const youtube = google.youtube({ version: 'v3', auth: process.env.GOOGLE_API_KEY || process.env.YOUTUBE_API_KEY });

  const res = await youtube.channels.list({
    id: channelId,
    part: 'snippet,statistics',
  });

  const channel = res.data.items?.[0];
  if (!channel) return null;

  return {
    id: channel.id,
    title: channel.snippet?.title,
    description: (channel.snippet?.description || '').substring(0, 300),
    subscribers: channel.statistics?.subscriberCount,
    videoCount: channel.statistics?.videoCount,
    thumbnail: channel.snippet?.thumbnails?.default?.url,
  };
}

/**
 * Obtener últimos videos de un canal.
 */
async function getLatestVideos(channelId, limit = 5) {
  const youtube = google.youtube({ version: 'v3', auth: process.env.GOOGLE_API_KEY || process.env.YOUTUBE_API_KEY });

  const res = await youtube.search.list({
    channelId,
    part: 'snippet',
    type: 'video',
    maxResults: limit,
    order: 'date',
  });

  return (res.data.items || []).map(item => ({
    videoId: item.id?.videoId,
    title: item.snippet?.title,
    publishedAt: item.snippet?.publishedAt,
    url: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
  }));
}

// ═══════════════════════════════════════════════════════════════
// 5. GOOGLE BUSINESS PROFILE (via Gemini google_search)
// ═══════════════════════════════════════════════════════════════

/**
 * Buscar info del perfil de negocio del owner en Google.
 */
async function getBusinessProfile(businessName, location, aiGateway) {
  const searchPrompt = `Buscar el perfil de Google Business de "${businessName}" ${location ? `en ${location}` : ''}.
Devolvé JSON con: { "name": "", "address": "", "phone": "", "rating": 0, "reviewCount": 0, "hours": "", "website": "", "category": "", "description": "" }
SOLO JSON, sin texto adicional.`;

  try {
    const result = await aiGateway.smartCall(
      aiGateway.CONTEXTS?.GENERAL || 'general',
      searchPrompt, {}, { enableSearch: true }
    );
    const jsonMatch = (result?.text || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const profile = JSON.parse(jsonMatch[0]);
      console.log(`[GOOGLE-BUSINESS] 🏢 Perfil encontrado: ${profile.name}`);
      return profile;
    }
    console.warn(`[GOOGLE-BUSINESS] ⚠️ No se encontró perfil para "${businessName}"`);
    return null;
  } catch (err) {
    console.error(`[GOOGLE-BUSINESS] ❌ Error:`, err.message);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// TAG DETECTION
// ═══════════════════════════════════════════════════════════════

const SERVICE_TAG_PATTERNS = {
  BUSCAR_CONTACTO: /\[BUSCAR_CONTACTO:([^\]]+)\]/,
  CREAR_CONTACTO: /\[CREAR_CONTACTO:([^\]]+)\]/,
  BUSCAR_DRIVE: /\[BUSCAR_DRIVE:([^\]]+)\]/,
  SUBIR_DRIVE: /\[SUBIR_DRIVE:([^\]]+)\]/,
  BUSCAR_LUGAR: /\[BUSCAR_LUGAR:([^\]]+)\]/,
  BUSCAR_YOUTUBE: /\[BUSCAR_YOUTUBE:([^\]]+)\]/,
  BUSCAR_NEGOCIO: /\[BUSCAR_NEGOCIO:([^\]]+)\]/,
};

function detectServiceTags(message) {
  if (!message) return [];
  const found = [];
  for (const [tag, pattern] of Object.entries(SERVICE_TAG_PATTERNS)) {
    const match = message.match(pattern);
    if (match) {
      found.push({ tag, params: match[1].split('|').map(p => p.trim()) });
    }
  }
  return found;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Contacts
  listContacts,
  createContact,

  // Drive
  listDriveFiles,
  uploadToDrive,
  shareDriveFile,

  // Places
  searchPlaces,

  // YouTube
  searchYouTube,
  getChannelInfo,
  getLatestVideos,

  // Business Profile
  getBusinessProfile,

  // Tags
  detectServiceTags,
  SERVICE_TAG_PATTERNS,
};
