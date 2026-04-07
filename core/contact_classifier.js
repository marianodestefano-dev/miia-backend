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

module.exports = {
  addPendingClassification,
  getPendingClassifications,
  tryClassifyFromOwnerMessage,
  reclassifyContact,
  removePending,
  cleanupStale
};
