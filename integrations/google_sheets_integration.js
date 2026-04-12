'use strict';

/**
 * GOOGLE SHEETS INTEGRATION — MIIA lee, escribe y analiza Google Sheets.
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Funcionalidades:
 *   1. Listar hojas de cálculo del owner
 *   2. Leer datos de una hoja (rango o completa)
 *   3. Escribir datos en una hoja (append o update)
 *   4. Crear nueva hoja de cálculo
 *   5. Análisis IA de datos (resumen, tendencias, anomalías)
 *
 * Tags WhatsApp (interceptados por server.js/TMH):
 *   [SHEET_LEER:spreadsheetId|rango]
 *   [SHEET_ESCRIBIR:spreadsheetId|rango|datos]
 *   [SHEET_CREAR:nombre]
 *   [SHEET_ANALIZAR:spreadsheetId|pregunta]
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

const { google } = require('googleapis');
const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════════
// GET SHEETS CLIENT — Obtiene cliente autenticado de Sheets
// ═══════════════════════════════════════════════════════════════

/**
 * Obtiene un cliente de Google Sheets autenticado para un usuario.
 * Reutiliza los mismos googleTokens del Calendar/Gmail (OAuth unificado).
 * @param {string} uid - UID del owner en Firestore
 * @returns {Promise<google.sheets_v4.Sheets>} Cliente de Sheets
 */
async function getSheetsClient(uid) {
  const doc = await admin.firestore().collection('users').doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  if (!data.googleTokens) throw new Error('Google no conectado — el owner debe vincular su cuenta Google desde el dashboard');

  const { getOAuth2Client } = require('../core/google_calendar');
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(data.googleTokens);

  // Auto-refresh
  oauth2Client.on('tokens', async (tokens) => {
    const updated = { ...data.googleTokens, ...tokens };
    await admin.firestore().collection('users').doc(uid).set({ googleTokens: updated }, { merge: true });
    console.log('[SHEETS] 🔄 Token auto-refreshed');
  });

  return google.sheets({ version: 'v4', auth: oauth2Client });
}

/**
 * Obtiene un cliente de Google Docs autenticado para un usuario.
 * @param {string} uid - UID del owner en Firestore
 * @returns {Promise<google.docs_v1.Docs>} Cliente de Docs
 */
async function getDocsClient(uid) {
  const doc = await admin.firestore().collection('users').doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  if (!data.googleTokens) throw new Error('Google no conectado');

  const { getOAuth2Client } = require('../core/google_calendar');
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(data.googleTokens);

  oauth2Client.on('tokens', async (tokens) => {
    const updated = { ...data.googleTokens, ...tokens };
    await admin.firestore().collection('users').doc(uid).set({ googleTokens: updated }, { merge: true });
  });

  return google.docs({ version: 'v1', auth: oauth2Client });
}

/**
 * Obtiene un cliente de Google Drive autenticado (para listar archivos).
 * @param {string} uid - UID del owner en Firestore
 * @returns {Promise<google.drive_v3.Drive>} Cliente de Drive
 */
async function getDriveClient(uid) {
  const doc = await admin.firestore().collection('users').doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  if (!data.googleTokens) throw new Error('Google no conectado');

  const { getOAuth2Client } = require('../core/google_calendar');
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(data.googleTokens);

  oauth2Client.on('tokens', async (tokens) => {
    const updated = { ...data.googleTokens, ...tokens };
    await admin.firestore().collection('users').doc(uid).set({ googleTokens: updated }, { merge: true });
  });

  return google.drive({ version: 'v3', auth: oauth2Client });
}

// ═══════════════════════════════════════════════════════════════
// SHEETS OPERATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Lista las hojas de cálculo recientes del owner (via Drive).
 * @param {string} uid
 * @param {number} [maxResults=10]
 * @returns {Promise<Array<{id: string, name: string, url: string, modifiedTime: string}>>}
 */
async function listSpreadsheets(uid, maxResults = 10) {
  const drive = await getDriveClient(uid);
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: 'files(id, name, webViewLink, modifiedTime)',
    orderBy: 'modifiedByMeTime desc',
    pageSize: maxResults,
  });
  const files = res.data.files || [];
  console.log(`[SHEETS] 📋 Listados ${files.length} spreadsheets para uid=${uid}`);
  return files.map(f => ({ id: f.id, name: f.name, url: f.webViewLink, modifiedTime: f.modifiedTime }));
}

/**
 * Lee datos de una hoja de cálculo.
 * @param {string} uid
 * @param {string} spreadsheetId - ID del spreadsheet
 * @param {string} [range='Sheet1'] - Rango A1 notation (ej: "Sheet1!A1:D10")
 * @returns {Promise<{values: string[][], sheetTitle: string, totalRows: number, totalCols: number}>}
 */
async function readSheet(uid, spreadsheetId, range = 'Sheet1') {
  const sheets = await getSheetsClient(uid);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const values = res.data.values || [];
  console.log(`[SHEETS] 📖 Leídas ${values.length} filas de ${spreadsheetId} rango=${range}`);
  return {
    values,
    sheetTitle: range.split('!')[0] || 'Sheet1',
    totalRows: values.length,
    totalCols: values.length > 0 ? values[0].length : 0,
  };
}

/**
 * Escribe datos en una hoja de cálculo (UPDATE — sobreescribe rango).
 * @param {string} uid
 * @param {string} spreadsheetId
 * @param {string} range - Rango A1 (ej: "Sheet1!A1:B3")
 * @param {string[][]} values - Array 2D de valores
 * @returns {Promise<{updatedCells: number, updatedRows: number}>}
 */
async function writeSheet(uid, spreadsheetId, range, values) {
  const sheets = await getSheetsClient(uid);
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  console.log(`[SHEETS] ✏️ Escritas ${res.data.updatedCells} celdas en ${spreadsheetId} rango=${range}`);
  return {
    updatedCells: res.data.updatedCells,
    updatedRows: res.data.updatedRows,
  };
}

/**
 * Añade filas al final de una hoja (APPEND).
 * @param {string} uid
 * @param {string} spreadsheetId
 * @param {string} range - Rango base (ej: "Sheet1!A:Z")
 * @param {string[][]} values - Filas a añadir
 * @returns {Promise<{updatedCells: number, updatedRange: string}>}
 */
async function appendSheet(uid, spreadsheetId, range, values) {
  const sheets = await getSheetsClient(uid);
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  console.log(`[SHEETS] ➕ Añadidas ${values.length} filas a ${spreadsheetId} rango=${range}`);
  return {
    updatedCells: res.data.updates?.updatedCells || 0,
    updatedRange: res.data.updates?.updatedRange || range,
  };
}

/**
 * Crea un nuevo spreadsheet.
 * @param {string} uid
 * @param {string} title - Nombre del spreadsheet
 * @param {string[]} [sheetNames=['Hoja1']] - Nombres de las hojas
 * @returns {Promise<{spreadsheetId: string, url: string}>}
 */
async function createSpreadsheet(uid, title, sheetNames = ['Hoja1']) {
  const sheets = await getSheetsClient(uid);
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: sheetNames.map(name => ({ properties: { title: name } })),
    },
  });
  const id = res.data.spreadsheetId;
  const url = `https://docs.google.com/spreadsheets/d/${id}`;
  console.log(`[SHEETS] 🆕 Spreadsheet creado: "${title}" → ${url}`);
  return { spreadsheetId: id, url };
}

/**
 * Obtiene metadatos de un spreadsheet (nombres de hojas, tamaño).
 * @param {string} uid
 * @param {string} spreadsheetId
 * @returns {Promise<{title: string, sheets: Array<{title: string, index: number, rowCount: number, colCount: number}>, url: string}>}
 */
async function getSpreadsheetInfo(uid, spreadsheetId) {
  const sheets = await getSheetsClient(uid);
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties',
  });
  const info = {
    title: res.data.properties.title,
    sheets: (res.data.sheets || []).map(s => ({
      title: s.properties.title,
      index: s.properties.index,
      rowCount: s.properties.gridProperties?.rowCount || 0,
      colCount: s.properties.gridProperties?.columnCount || 0,
    })),
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
  console.log(`[SHEETS] ℹ️ Info: "${info.title}" — ${info.sheets.length} hojas`);
  return info;
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE DOCS OPERATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Crea un nuevo Google Doc con contenido.
 * @param {string} uid
 * @param {string} title - Nombre del documento
 * @param {string} content - Texto plano a escribir
 * @returns {Promise<{documentId: string, url: string}>}
 */
async function createDocument(uid, title, content) {
  const docs = await getDocsClient(uid);
  // Crear doc vacío
  const createRes = await docs.documents.create({ requestBody: { title } });
  const docId = createRes.data.documentId;

  // Escribir contenido
  if (content && content.trim()) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{
          insertText: {
            location: { index: 1 },
            text: content,
          },
        }],
      },
    });
  }

  const url = `https://docs.google.com/document/d/${docId}`;
  console.log(`[DOCS] 🆕 Documento creado: "${title}" → ${url}`);
  return { documentId: docId, url };
}

/**
 * Lee el contenido de un Google Doc.
 * @param {string} uid
 * @param {string} documentId
 * @returns {Promise<{title: string, content: string, url: string}>}
 */
async function readDocument(uid, documentId) {
  const docs = await getDocsClient(uid);
  const res = await docs.documents.get({ documentId });
  const doc = res.data;
  // Extraer texto plano de los elementos del body
  let text = '';
  if (doc.body?.content) {
    for (const el of doc.body.content) {
      if (el.paragraph?.elements) {
        for (const e of el.paragraph.elements) {
          if (e.textRun?.content) text += e.textRun.content;
        }
      }
    }
  }
  console.log(`[DOCS] 📖 Leído doc "${doc.title}" — ${text.length} chars`);
  return { title: doc.title, content: text, url: `https://docs.google.com/document/d/${documentId}` };
}

/**
 * Añade texto al final de un Google Doc existente.
 * @param {string} uid
 * @param {string} documentId
 * @param {string} text - Texto a añadir
 * @returns {Promise<void>}
 */
async function appendDocument(uid, documentId, text) {
  const docs = await getDocsClient(uid);
  // Obtener la longitud actual del documento para saber dónde insertar
  const docRes = await docs.documents.get({ documentId });
  const body = docRes.data.body;
  const endIndex = body?.content?.slice(-1)?.[0]?.endIndex || 1;

  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: Math.max(1, endIndex - 1) },
          text: '\n' + text,
        },
      }],
    },
  });
  console.log(`[DOCS] ➕ Añadido texto a doc ${documentId} — ${text.length} chars`);
}

// ═══════════════════════════════════════════════════════════════
// SHEET ANALYSIS — Resumen IA de datos
// ═══════════════════════════════════════════════════════════════

/**
 * Genera un análisis IA de los datos de un spreadsheet.
 * @param {string[][]} data - Datos del spreadsheet (primera fila = headers)
 * @param {string} question - Pregunta del owner
 * @param {object} aiGateway - Instancia del AI gateway
 * @returns {Promise<string>} Análisis en texto
 */
async function analyzeSheetData(data, question, aiGateway) {
  if (!data || data.length < 2) return 'La hoja está vacía o no tiene datos suficientes para analizar.';

  const headers = data[0];
  const rows = data.slice(1);
  const sampleRows = rows.slice(0, 50); // Máximo 50 filas para el prompt

  const dataStr = [headers.join(' | '), ...sampleRows.map(r => r.join(' | '))].join('\n');

  const prompt = `Sos MIIA, analista de datos. El owner te pide que analices este spreadsheet.

## DATOS (${rows.length} filas, ${headers.length} columnas):
${dataStr}
${rows.length > 50 ? `\n(Mostrando 50 de ${rows.length} filas)` : ''}

## PREGUNTA DEL OWNER:
${question || 'Hacé un resumen ejecutivo de estos datos.'}

## INSTRUCCIONES:
- Respondé en español, máximo 10 líneas
- Incluí números concretos, porcentajes, tendencias
- Si detectás anomalías o datos faltantes, mencionalo
- Sé directo y útil, no decorativo
- Si la pregunta es sobre un cálculo, HACELO y dá el resultado`;

  const result = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, prompt, {}, { enableSearch: false });
  return result?.text?.trim() || 'No pude generar el análisis.';
}

// ═══════════════════════════════════════════════════════════════
// TAG PARSER — Parsea tags de Sheets/Docs desde mensajes de MIIA
// ═══════════════════════════════════════════════════════════════

const SHEET_TAG_PATTERNS = {
  SHEET_LEER: /\[SHEET_LEER:([^|]+?)(?:\|([^\]]+))?\]/,
  SHEET_ESCRIBIR: /\[SHEET_ESCRIBIR:([^|]+?)\|([^|]+?)\|([^\]]+)\]/,
  SHEET_APPEND: /\[SHEET_APPEND:([^|]+?)\|([^|]+?)\|([^\]]+)\]/,
  SHEET_CREAR: /\[SHEET_CREAR:([^\]]+)\]/,
  SHEET_ANALIZAR: /\[SHEET_ANALIZAR:([^|]+?)(?:\|([^\]]+))?\]/,
  DOC_CREAR: /\[DOC_CREAR:([^|]+?)\|([^\]]+)\]/,
  DOC_LEER: /\[DOC_LEER:([^\]]+)\]/,
  DOC_APPEND: /\[DOC_APPEND:([^|]+?)\|([^\]]+)\]/,
};

/**
 * Detecta tags de Sheets/Docs en un mensaje de IA.
 * @param {string} message
 * @returns {Array<{tag: string, params: string[]}>}
 */
function detectSheetTags(message) {
  if (!message) return [];
  const found = [];
  for (const [tag, pattern] of Object.entries(SHEET_TAG_PATTERNS)) {
    const match = message.match(pattern);
    if (match) {
      found.push({ tag, params: match.slice(1).filter(Boolean) });
    }
  }
  return found;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Sheets
  getSheetsClient,
  listSpreadsheets,
  readSheet,
  writeSheet,
  appendSheet,
  createSpreadsheet,
  getSpreadsheetInfo,
  analyzeSheetData,

  // Docs
  getDocsClient,
  createDocument,
  readDocument,
  appendDocument,

  // Drive
  getDriveClient,

  // Tag detection
  detectSheetTags,
  SHEET_TAG_PATTERNS,
};
