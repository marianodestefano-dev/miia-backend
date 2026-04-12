/**
 * google_tasks_integration.js — Integración Google Tasks para MIIA
 *
 * Permite a MIIA crear, listar, completar y eliminar tareas en Google Tasks.
 * Funciona via self-chat commands y tags en el prompt.
 *
 * Standard: Google + Amazon + Apple + NASA — fail loudly, exhaustive logging
 */

const { google } = require('googleapis');

// ═══════════════════════════════════════════════════════
// GOOGLE TASKS CLIENT
// ═══════════════════════════════════════════════════════

/**
 * Obtiene cliente autenticado de Google Tasks
 * @param {string} uid - UID del usuario en Firestore
 * @param {Function} getOAuth2Client - Factory del OAuth2 client
 * @param {object} admin - Firebase admin instance
 * @returns {{ tasks: object, listId: string }}
 */
async function getTasksClient(uid, getOAuth2Client, admin) {
  const doc = await admin.firestore().collection('users').doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  if (!data.googleTokens) throw new Error('Google no conectado para este usuario');

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(data.googleTokens);

  // Auto-refresh token
  oauth2Client.on('tokens', async (tokens) => {
    const updated = { ...data.googleTokens, ...tokens };
    await admin.firestore().collection('users').doc(uid).set({ googleTokens: updated }, { merge: true });
    console.log(`[TASKS] 🔄 Token refrescado para uid=${uid}`);
  });

  const tasks = google.tasks({ version: 'v1', auth: oauth2Client });
  const listId = data.googleTasksListId || '@default';

  return { tasks, listId };
}

// ═══════════════════════════════════════════════════════
// CRUD DE TAREAS
// ═══════════════════════════════════════════════════════

/**
 * Crear una tarea nueva
 * @returns {{ id, title, due, status, link }}
 */
async function createTask(uid, getOAuth2Client, admin, { title, notes, dueDate }) {
  const { tasks, listId } = await getTasksClient(uid, getOAuth2Client, admin);

  const taskBody = {
    title: title,
    notes: notes || 'Creada por MIIA',
    status: 'needsAction'
  };

  // dueDate debe ser ISO string YYYY-MM-DD o datetime
  if (dueDate) {
    // Google Tasks quiere RFC 3339 con hora 00:00:00.000Z
    const d = new Date(dueDate);
    if (!isNaN(d)) {
      taskBody.due = d.toISOString();
    }
  }

  const res = await tasks.tasks.insert({ tasklist: listId, requestBody: taskBody });
  const t = res.data;
  console.log(`[TASKS] ✅ Tarea creada: "${title}" (id=${t.id}) para uid=${uid}`);

  return {
    id: t.id,
    title: t.title,
    due: t.due || null,
    status: t.status,
    link: t.selfLink
  };
}

/**
 * Listar tareas pendientes (needsAction)
 * @param {object} opts - { maxResults, showCompleted, dueMax }
 * @returns {Array<{ id, title, due, notes, status }>}
 */
async function listTasks(uid, getOAuth2Client, admin, opts = {}) {
  const { tasks, listId } = await getTasksClient(uid, getOAuth2Client, admin);

  const params = {
    tasklist: listId,
    maxResults: opts.maxResults || 20,
    showCompleted: opts.showCompleted || false,
    showHidden: false
  };

  if (opts.dueMax) {
    const d = new Date(opts.dueMax);
    if (!isNaN(d)) params.dueMax = d.toISOString();
  }

  const res = await tasks.tasks.list(params);
  const items = (res.data.items || []).map(t => ({
    id: t.id,
    title: t.title,
    due: t.due || null,
    notes: t.notes || '',
    status: t.status,
    updated: t.updated
  }));

  console.log(`[TASKS] 📋 ${items.length} tareas listadas para uid=${uid}`);
  return items;
}

/**
 * Completar una tarea por ID o título parcial
 */
async function completeTask(uid, getOAuth2Client, admin, { taskId, titleMatch }) {
  const { tasks, listId } = await getTasksClient(uid, getOAuth2Client, admin);

  let targetId = taskId;
  let targetTitle = '';

  // Si no hay ID, buscar por título con scoring (NO includes suelto — puede completar tarea equivocada)
  if (!targetId && titleMatch) {
    const all = await listTasks(uid, getOAuth2Client, admin, { maxResults: 50 });
    const searchLower = titleMatch.toLowerCase();
    const searchWords = searchLower.split(/\s+/).filter(w => w.length > 2);
    let bestScore = 0;
    let bestMatch = null;
    for (const t of all) {
      const titleLower = (t.title || '').toLowerCase();
      let score = 0;
      if (titleLower === searchLower) {
        score = 100;
      } else {
        const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);
        let fwd = 0;
        for (const w of searchWords) { if (titleLower.includes(w)) fwd++; }
        let rev = 0;
        for (const w of titleWords) { if (searchLower.includes(w)) rev++; }
        const fwdPct = searchWords.length > 0 ? fwd / searchWords.length : 0;
        const revPct = titleWords.length > 0 ? rev / titleWords.length : 0;
        score = Math.round(fwdPct * 60 + revPct * 40);
      }
      console.log(`[TASKS] 📊 Score "${t.title}" = ${score}`);
      if (score > bestScore) { bestScore = score; bestMatch = t; }
    }
    if (!bestMatch || bestScore < 45) {
      console.warn(`[TASKS] ⚠️ No se encontró tarea con título "${titleMatch}" (mejor score=${bestScore} < 45)`);
      return null;
    }
    targetId = bestMatch.id;
    targetTitle = bestMatch.title;
    console.log(`[TASKS] 🎯 Match: "${targetTitle}" (score=${bestScore})`);
  }

  if (!targetId) {
    console.warn(`[TASKS] ⚠️ No se proporcionó ID ni título para completar`);
    return null;
  }

  // Obtener la tarea actual y marcarla como completada
  const current = await tasks.tasks.get({ tasklist: listId, task: targetId });
  targetTitle = current.data.title;

  await tasks.tasks.update({
    tasklist: listId,
    task: targetId,
    requestBody: { ...current.data, status: 'completed' }
  });

  console.log(`[TASKS] ✅ Tarea completada: "${targetTitle}" (id=${targetId})`);
  return { id: targetId, title: targetTitle, status: 'completed' };
}

/**
 * Eliminar una tarea
 */
async function deleteTask(uid, getOAuth2Client, admin, { taskId, titleMatch }) {
  const { tasks, listId } = await getTasksClient(uid, getOAuth2Client, admin);

  let targetId = taskId;
  let targetTitle = '';

  if (!targetId && titleMatch) {
    const all = await listTasks(uid, getOAuth2Client, admin, { maxResults: 50, showCompleted: true });
    const searchLower = titleMatch.toLowerCase();
    const searchWords = searchLower.split(/\s+/).filter(w => w.length > 2);
    let bestScore = 0;
    let bestMatch = null;
    for (const t of all) {
      const titleLower = (t.title || '').toLowerCase();
      let score = 0;
      if (titleLower === searchLower) {
        score = 100;
      } else {
        const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);
        let fwd = 0;
        for (const w of searchWords) { if (titleLower.includes(w)) fwd++; }
        let rev = 0;
        for (const w of titleWords) { if (searchLower.includes(w)) rev++; }
        const fwdPct = searchWords.length > 0 ? fwd / searchWords.length : 0;
        const revPct = titleWords.length > 0 ? rev / titleWords.length : 0;
        score = Math.round(fwdPct * 60 + revPct * 40);
      }
      if (score > bestScore) { bestScore = score; bestMatch = t; }
    }
    if (!bestMatch || bestScore < 45) {
      console.warn(`[TASKS] ⚠️ No se encontró tarea para eliminar: "${titleMatch}" (mejor score=${bestScore} < 45)`);
      return null;
    }
    targetId = bestMatch.id;
    targetTitle = bestMatch.title;
    console.log(`[TASKS] 🎯 Match para eliminar: "${targetTitle}" (score=${bestScore})`);
  }

  if (!targetId) return null;

  await tasks.tasks.delete({ tasklist: listId, task: targetId });
  console.log(`[TASKS] 🗑️ Tarea eliminada: "${targetTitle || targetId}"`);
  return { id: targetId, deleted: true };
}

// ═══════════════════════════════════════════════════════
// DETECCIÓN DE COMANDOS EN SELF-CHAT
// ═══════════════════════════════════════════════════════

/**
 * Detecta comandos de Google Tasks en mensajes del owner
 * @param {string} message - Texto del mensaje
 * @returns {{ action: string, params: object } | null}
 */
function detectTasksCommand(message) {
  const msg = message.toLowerCase().trim();

  // "mis tareas", "qué tareas tengo", "tareas pendientes", "lista de tareas"
  if (/(?:mis\s+tareas|qu[eé]\s+tareas\s+tengo|tareas\s+pendientes|lista\s+de\s+tareas|show\s+tasks)/i.test(msg)) {
    return { action: 'list', params: {} };
  }

  // "tarea: comprar leche" o "agregar tarea comprar leche" o "nueva tarea: ..."
  const createMatch = msg.match(/(?:tarea:\s*|agregar\s+tarea\s+|nueva\s+tarea:?\s*|crear\s+tarea:?\s*)(.+)/i);
  if (createMatch) {
    const title = createMatch[1].trim();
    // Extraer fecha si existe: "para el viernes", "para 2026-04-10"
    const dateMatch = title.match(/\s+para\s+(?:el\s+)?(.+)$/i);
    return {
      action: 'create',
      params: {
        title: dateMatch ? title.replace(dateMatch[0], '').trim() : title,
        dateHint: dateMatch ? dateMatch[1].trim() : null
      }
    };
  }

  // "completar tarea X" o "tarea X lista" o "ya hice X"
  const completeMatch = msg.match(/(?:completar\s+tarea\s+|tarea\s+(.+?)\s+(?:lista|hecha|terminada)|ya\s+hice\s+(?:la\s+tarea\s+)?(.+))/i);
  if (completeMatch) {
    const titleMatch = (completeMatch[1] || completeMatch[2] || '').trim();
    return { action: 'complete', params: { titleMatch } };
  }

  // "eliminar tarea X" o "borrar tarea X"
  const deleteMatch = msg.match(/(?:eliminar|borrar|quitar)\s+tarea\s+(.+)/i);
  if (deleteMatch) {
    return { action: 'delete', params: { titleMatch: deleteMatch[1].trim() } };
  }

  return null;
}

// ═══════════════════════════════════════════════════════
// FORMATEO PARA WHATSAPP
// ═══════════════════════════════════════════════════════

function formatTasksList(tasks) {
  if (!tasks || tasks.length === 0) {
    return '📋 No tenés tareas pendientes. ¡Todo al día! 🎉';
  }

  let msg = `📋 *Tus tareas pendientes (${tasks.length}):*\n\n`;
  tasks.forEach((t, i) => {
    const due = t.due ? ` 📅 ${new Date(t.due).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}` : '';
    msg += `${i + 1}. ${t.title}${due}\n`;
  });
  msg += '\n_Decime "completar tarea [nombre]" o "nueva tarea: [texto]"_';
  return msg;
}

// ═══════════════════════════════════════════════════════
// TAG HANDLER — [CREAR_TAREA:título|fecha|notas]
// ═══════════════════════════════════════════════════════

/**
 * Parsea el tag [CREAR_TAREA:título|fecha|notas] del prompt de MIIA
 * @param {string} text - Respuesta de la IA
 * @returns {{ title, dueDate, notes } | null}
 */
function parseTaskTag(text) {
  const match = text.match(/\[CREAR_TAREA:([^\]]+)\]/);
  if (!match) return null;

  const parts = match[1].split('|').map(s => s.trim());
  return {
    title: parts[0] || 'Tarea sin título',
    dueDate: parts[1] || null,
    notes: parts[2] || null,
    rawTag: match[0]
  };
}

/**
 * Parsea [LISTAR_TAREAS] del prompt
 */
function parseListTasksTag(text) {
  return /\[LISTAR_TAREAS\]/.test(text);
}

/**
 * Parsea [COMPLETAR_TAREA:título_parcial]
 */
function parseCompleteTaskTag(text) {
  const match = text.match(/\[COMPLETAR_TAREA:([^\]]+)\]/);
  if (!match) return null;
  return { titleMatch: match[1].trim(), rawTag: match[0] };
}

module.exports = {
  createTask,
  listTasks,
  completeTask,
  deleteTask,
  detectTasksCommand,
  formatTasksList,
  parseTaskTag,
  parseListTasksTag,
  parseCompleteTaskTag,
  getTasksClient
};
