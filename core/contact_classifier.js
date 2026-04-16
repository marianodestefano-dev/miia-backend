// ════════════════════════════════════════════════════════════════════════════
// MIIA — Contact Classifier (P3.1)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Procesa respuestas del owner en self-chat para clasificar contactos
// pendientes. Ej: "5491155... es amigo", "medilink", "familia", "ignorar"
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
let _db = null;
function db() { if (!_db) _db = admin.firestore(); return _db; }

// Cache de contactos pendientes por owner: { uid: [{ phone, messagePreview, timestamp }] }
const pendingClassifications = {};

/**
 * Registra un contacto como pendiente de clasificación por el owner.
 */
function addPendingClassification(ownerUid, phone, messagePreview) {
  if (!pendingClassifications[ownerUid]) pendingClassifications[ownerUid] = [];
  // Evitar duplicados
  const existing = pendingClassifications[ownerUid].find(p => p.phone === phone);
  if (existing) {
    existing.messagePreview = messagePreview;
    existing.timestamp = Date.now();
    return;
  }
  pendingClassifications[ownerUid].push({ phone, messagePreview, timestamp: Date.now() });
  console.log(`[CLASSIFIER] 📋 Pendiente: ${phone} para owner ${ownerUid} (total: ${pendingClassifications[ownerUid].length})`);
}

/**
 * Obtiene los contactos pendientes de un owner.
 */
function getPendingClassifications(ownerUid) {
  return pendingClassifications[ownerUid] || [];
}

/**
 * Intenta procesar un mensaje del owner como respuesta de clasificación.
 * Detecta patrones como:
 *   - "amigo" / "familia" / "equipo" / "ignorar" → clasifica el último pendiente
 *   - "5491155... es amigo" → clasifica un teléfono específico
 *   - "medilink" / nombre de negocio → asigna como lead de ese negocio
 *   - "mover 5491155... a familia" → reclasifica
 *
 * @returns {{ handled: boolean, response?: string }}
 */
async function tryClassifyFromOwnerMessage(ownerUid, messageBody, businesses) {
  const msg = messageBody.trim().toLowerCase();
  const pending = pendingClassifications[ownerUid] || [];

  // ── Patrón 1: "clasificar PHONE como TIPO" o "PHONE es TIPO" ──
  const specificMatch = msg.match(
    /(?:clasificar\s+)?(\+?\d[\d\s-]{6,20})\s+(?:es|como|→)\s+(amigo|familia|equipo|lead|ignorar|cliente|.+)/i
  );
  if (specificMatch) {
    const phoneRaw = specificMatch[1].replace(/[^0-9]/g, '');
    const tipo = specificMatch[2].trim();
    return await classifyContact(ownerUid, phoneRaw, tipo, businesses, pending);
  }

  // ── Patrón 2: "mover PHONE a GRUPO" ──
  const moveMatch = msg.match(
    /mover\s+(\+?\d[\d\s-]{6,20})\s+a\s+(.+)/i
  );
  if (moveMatch) {
    const phoneRaw = moveMatch[1].replace(/[^0-9]/g, '');
    const destino = moveMatch[2].trim();
    return await reclassifyContact(ownerUid, phoneRaw, destino, businesses);
  }

  // ── Patrón 3: Solo tipo/grupo (aplica al último pendiente) ──
  if (pending.length > 0) {
    const quickTypes = ['amigo', 'familia', 'equipo', 'ignorar', 'cliente'];
    if (quickTypes.includes(msg)) {
      const last = pending[pending.length - 1];
      return await classifyContact(ownerUid, last.phone, msg, businesses, pending);
    }

    // ── Patrón 3b: Lenguaje natural → mapear a tipo ──
    // "es mi primo" → familia, "es un amigo" → amigo, "es mi hermano" → familia
    // "mi primo chapy" → familia, "es cliente" → cliente, "no le respondas" → ignorar
    const naturalLanguageMap = [
      // FAMILIA: primo, hermano, mamá, papá, tío, cuñado, sobrino, esposa, pareja, novio/a, suegro/a, abuelo/a
      { pattern: /(?:es\s+)?(?:mi|un|una)\s+(?:primo|prima|hermano|hermana|mama|mam[aá]|papa|pap[aá]|tio|t[ií]o|tia|t[ií]a|cuñado|cuñada|sobrino|sobrina|esposo|esposa|pareja|novio|novia|suegro|suegra|abuelo|abuela|hijo|hija|familiar|pariente)/, type: 'familia' },
      { pattern: /(?:es\s+)?familia/, type: 'familia' },
      // AMIGO: amigo, amiga, compa, compañero, pana, brother, parcero, conocido
      { pattern: /(?:es\s+)?(?:mi|un|una)\s+(?:amigo|amiga|compa|compañero|compañera|pana|brother|parcero|parcera|conocido|conocida|colega|vecino|vecina)/, type: 'amigo' },
      { pattern: /(?:es\s+)?(?:amigo|amiga)/, type: 'amigo' },
      // EQUIPO: empleado, trabajador, colaborador, socio
      { pattern: /(?:es\s+)?(?:mi|un|una)\s+(?:empleado|empleada|trabajador|trabajadora|colaborador|colaboradora|socio|socia|asistente|secretario|secretaria)/, type: 'equipo' },
      { pattern: /(?:es\s+)?(?:del\s+)?equipo/, type: 'equipo' },
      // IGNORAR: no respondas, ignoralo, no le escribas, spam
      { pattern: /(?:no\s+(?:le\s+)?respond|ignor[aáe]|no\s+le\s+escrib|spam|basura|bloquea)/, type: 'ignorar' },
      // CLIENTE/LEAD
      { pattern: /(?:es\s+)?(?:mi|un|una)\s+(?:cliente|paciente|alumno|alumna|lead)/, type: 'cliente' },
      { pattern: /(?:es\s+)?cliente/, type: 'cliente' },
    ];

    for (const { pattern, type } of naturalLanguageMap) {
      if (pattern.test(msg)) {
        const last = pending[pending.length - 1];
        console.log(`[CLASSIFIER] 🧠 Lenguaje natural "${msg.substring(0, 40)}" → tipo="${type}" para ${last.phone}`);
        return await classifyContact(ownerUid, last.phone, type, businesses, pending);
      }
    }

    // ¿Es nombre de negocio?
    const matchedBiz = (businesses || []).find(b =>
      b.name && msg.includes(b.name.toLowerCase())
    );
    if (matchedBiz && pending.length > 0) {
      const last = pending[pending.length - 1];
      return await classifyContact(ownerUid, last.phone, matchedBiz.name, businesses, pending);
    }
  }

  return { handled: false };
}

/**
 * Ejecuta la clasificación de un contacto específico.
 */
async function classifyContact(ownerUid, phone, tipo, businesses, pending) {
  const tipoLower = tipo.toLowerCase().trim();
  const basePhone = phone.replace('@s.whatsapp.net', '');

  try {
    if (tipoLower === 'ignorar') {
      // Marcar como ignorado en contact_index
      await db().collection('users').doc(ownerUid).collection('contact_index').doc(basePhone).set({
        type: 'ignored', name: '', updatedAt: new Date().toISOString()
      }, { merge: true });
      removePending(ownerUid, basePhone);
      console.log(`[CLASSIFIER] 🚫 ${basePhone} marcado como IGNORAR para ${ownerUid}`);
      return { handled: true, response: `✅ Listo, voy a ignorar a +${basePhone}. No le voy a responder más.` };
    }

    if (['amigo', 'familia', 'equipo'].includes(tipoLower)) {
      // Agregar a contact_group correspondiente
      const groupId = tipoLower === 'amigo' ? 'amigos' : tipoLower;

      // Crear grupo si no existe
      const groupRef = db().collection('users').doc(ownerUid).collection('contact_groups').doc(groupId);
      const groupDoc = await groupRef.get();
      if (!groupDoc.exists) {
        await groupRef.set({
          name: groupId.charAt(0).toUpperCase() + groupId.slice(1),
          icon: tipoLower === 'amigo' ? '👫' : tipoLower === 'familia' ? '👨‍👩‍👧‍👦' : '💼',
          tone: '',
          autoRespond: false,
          proactiveEnabled: false,
          createdAt: new Date().toISOString()
        });
        console.log(`[CLASSIFIER] 📁 Grupo "${groupId}" creado para ${ownerUid}`);
      }

      // Agregar contacto al grupo
      await groupRef.collection('contacts').doc(basePhone).set({
        name: '', phone: basePhone, addedAt: new Date().toISOString(), proactiveEnabled: false
      }, { merge: true });

      // Actualizar contact_index
      await db().collection('users').doc(ownerUid).collection('contact_index').doc(basePhone).set({
        type: 'group', groupId, groupName: groupId.charAt(0).toUpperCase() + groupId.slice(1),
        name: '', updatedAt: new Date().toISOString()
      }, { merge: true });

      removePending(ownerUid, basePhone);
      console.log(`[CLASSIFIER] ✅ ${basePhone} → grupo "${groupId}" para ${ownerUid}`);
      return { handled: true, response: `✅ +${basePhone} agregado a ${groupId.charAt(0).toUpperCase() + groupId.slice(1)}. La próxima vez que escriba, lo voy a tratar con ese tono.` };
    }

    // ¿Es nombre de negocio? → lead
    const matchedBiz = (businesses || []).find(b =>
      b.name && b.name.toLowerCase().includes(tipoLower)
    );
    if (matchedBiz) {
      await db().collection('users').doc(ownerUid).collection('contact_index').doc(basePhone).set({
        type: 'lead', businessId: matchedBiz.id, name: '', updatedAt: new Date().toISOString()
      }, { merge: true });
      removePending(ownerUid, basePhone);
      console.log(`[CLASSIFIER] ✅ ${basePhone} → lead de "${matchedBiz.name}" para ${ownerUid}`);
      return { handled: true, response: `✅ +${basePhone} asignado como lead de ${matchedBiz.name}. La próxima vez que escriba, le respondo como lead de ese negocio.` };
    }

    // No matcheó nada conocido
    return { handled: false };

  } catch (e) {
    console.error(`[CLASSIFIER] ❌ Error clasificando ${basePhone}:`, e.message);
    return { handled: true, response: `❌ Error al clasificar +${basePhone}: ${e.message}` };
  }
}

/**
 * Reclasifica un contacto ya clasificado (mover entre grupos/negocios).
 */
async function reclassifyContact(ownerUid, phone, destino, businesses) {
  const basePhone = phone.replace('@s.whatsapp.net', '');
  const destinoLower = destino.toLowerCase().trim();

  try {
    // Primero obtener clasificación actual
    const currentDoc = await db().collection('users').doc(ownerUid).collection('contact_index').doc(basePhone).get();
    const current = currentDoc.exists ? currentDoc.data() : null;

    // Si estaba en un grupo, remover de ese grupo
    if (current?.type === 'group' && current?.groupId) {
      try {
        await db().collection('users').doc(ownerUid)
          .collection('contact_groups').doc(current.groupId)
          .collection('contacts').doc(basePhone).delete();
        console.log(`[CLASSIFIER] 🔄 ${basePhone} removido de grupo "${current.groupId}"`);
      } catch (_) {}
    }

    // Reclasificar usando la misma lógica
    const result = await classifyContact(ownerUid, basePhone, destinoLower, businesses, []);
    if (result.handled) {
      return { handled: true, response: `🔄 ${result.response.replace('✅', '🔄 Movido:')}` };
    }

    return { handled: false };
  } catch (e) {
    console.error(`[CLASSIFIER] ❌ Error reclasificando ${basePhone}:`, e.message);
    return { handled: true, response: `❌ Error al mover +${basePhone}: ${e.message}` };
  }
}

/**
 * Remueve un contacto de la lista de pendientes.
 */
function removePending(ownerUid, phone) {
  if (!pendingClassifications[ownerUid]) return;
  pendingClassifications[ownerUid] = pendingClassifications[ownerUid].filter(p => p.phone !== phone);
}

/**
 * Limpia pendientes viejos (>24h).
 */
function cleanupStale() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const uid of Object.keys(pendingClassifications)) {
    pendingClassifications[uid] = pendingClassifications[uid].filter(p => p.timestamp > cutoff);
    if (pendingClassifications[uid].length === 0) delete pendingClassifications[uid];
  }
}

// Auto-cleanup cada hora
setInterval(cleanupStale, 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════════════
// DÍA 0 — Clasificación masiva con Gemini Flash
// ════════════════════════════════════════════════════════════════════════════

const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const BATCH_SIZE = 15;
const BATCH_DELAY_MS = 4000; // 4s entre batches para no pegar el rate limit (15 RPM)

/**
 * Construye el prompt para un batch de contactos.
 * @param {Array<{phone, pushName, messages: Array<{body, fromMe}>}>} batch
 * @returns {string}
 */
function buildBatchClassificationPrompt(batch) {
  let lines = '';
  for (let i = 0; i < batch.length; i++) {
    const c = batch[i];
    const preview = c.messages
      .slice(0, 8)
      .map(m => `${m.fromMe ? 'OWNER' : 'CONTACTO'}: ${m.body.substring(0, 80)}`)
      .join(' | ');
    lines += `${i + 1}. [${c.pushName || 'Sin nombre'}] ${preview.substring(0, 250)}\n`;
  }

  return `Clasificá estas ${batch.length} conversaciones de WhatsApp. Para cada una devolvé SOLO el número de línea y el tipo.

Tipos válidos: familia | amigo | equipo | lead | cliente | ignorar

Reglas:
- familia: relación personal íntima (mamá, hermano, primo, esposa, etc.), tono familiar
- amigo: tono informal personal, temas no relacionados al negocio, amigos/conocidos
- equipo: colega de trabajo, menciona la empresa, temas internos laborales
- lead: pregunta por software médico, precios, funcionalidades, interesado en comprar
- cliente: ya usa el producto, menciona facturas, soporte técnico, problemas con funcionalidades
- ignorar: bot automatizado, banco, courier, delivery, spam, mensajes genéricos sin conversación real, números sin contexto

Conversaciones:
${lines}
Respondé SOLO en JSON válido, sin explicaciones:
[{"line":1,"type":"familia"},{"line":2,"type":"lead"}]`;
}

/**
 * Clasifica contactos en batches usando Gemini Flash.
 * @param {Array<{phone, pushName, messages: Array<{body, fromMe}>}>} contacts
 * @param {string} geminiApiKey
 * @returns {Promise<Object<string, string>>} phone → tipo
 */
async function classifyContactsWithGemini(contacts, geminiApiKey) {
  if (!contacts || contacts.length === 0) return {};
  if (!geminiApiKey) {
    console.error('[CLASSIFIER-GEMINI] ❌ No API key — saltando clasificación');
    return {};
  }

  const results = {};
  const totalBatches = Math.ceil(contacts.length / BATCH_SIZE);
  console.log(`[CLASSIFIER-GEMINI] 🧬 Clasificando ${contacts.length} contactos en ${totalBatches} batches`);

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = contacts.slice(i, i + BATCH_SIZE);
    const prompt = buildBatchClassificationPrompt(batch);

    try {
      const resp = await fetch(`${GEMINI_FLASH_URL}?key=${geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error(`[CLASSIFIER-GEMINI] ❌ Batch ${batchNum}/${totalBatches}: HTTP ${resp.status} — ${errText.substring(0, 200)}`);
        batch.forEach(c => { results[c.phone] = 'ignorar'; });
        continue;
      }

      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Parsear JSON de la respuesta — buscar array en el texto
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn(`[CLASSIFIER-GEMINI] ⚠️ Batch ${batchNum}: no JSON encontrado en respuesta: "${text.substring(0, 100)}"`);
        batch.forEach(c => { results[c.phone] = 'ignorar'; });
        continue;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const VALID_TYPES = ['familia', 'amigo', 'equipo', 'lead', 'cliente', 'ignorar'];
      let classified = 0;

      for (const item of parsed) {
        if (typeof item.line !== 'number' || item.line < 1 || item.line > batch.length) continue;
        const contact = batch[item.line - 1];
        const tipo = VALID_TYPES.includes(item.type) ? item.type : 'ignorar';
        results[contact.phone] = tipo;
        classified++;
      }

      // Contactos del batch que no aparecieron en la respuesta → ignorar
      for (const c of batch) {
        if (!results[c.phone]) results[c.phone] = 'ignorar';
      }

      console.log(`[CLASSIFIER-GEMINI] ✅ Batch ${batchNum}/${totalBatches}: ${classified}/${batch.length} clasificados`);

    } catch (e) {
      console.error(`[CLASSIFIER-GEMINI] ❌ Batch ${batchNum}/${totalBatches}: ${e.message}`);
      batch.forEach(c => { results[c.phone] = 'ignorar'; });
    }

    // Rate limit pacing: esperar entre batches (excepto el último)
    if (i + BATCH_SIZE < contacts.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Stats
  const stats = {};
  for (const tipo of Object.values(results)) {
    stats[tipo] = (stats[tipo] || 0) + 1;
  }
  console.log(`[CLASSIFIER-GEMINI] 🧬 Resultado final:`, stats);

  return results;
}

module.exports = {
  addPendingClassification,
  getPendingClassifications,
  tryClassifyFromOwnerMessage,
  classifyContact,
  reclassifyContact,
  classifyContactsWithGemini,
  removePending,
  cleanupStale
};
