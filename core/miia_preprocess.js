'use strict';

/**
 * MIIA PRE-PROCESS v1.0 — Enriquecimiento de contexto ANTES de la llamada IA
 *
 * 4 enrichers que inyectan datos relevantes al prompt sin costo IA:
 * - enrichAgenda: eventos del día, conflictos, próximos eventos
 * - enrichAffinity: stage, último contacto, temas pendientes
 * - enrichProtection: modo kids, elderly, nivel emergencia
 * - enrichSales: perfil del lead, historial, intención detectada
 *
 * Cada enricher retorna un string para inyectar en el prompt (o '' si no aplica).
 * El orquestador los combina en un bloque [CONTEXTO ENRIQUECIDO].
 */

/**
 * Enriquecer con datos de agenda
 * @param {object} opts - { admin, ownerUid, phone, messageBody, agendaEvents }
 * @returns {string} Bloque de contexto de agenda
 */
function enrichAgenda(opts) {
  const { agendaEvents, messageBody } = opts;
  if (!agendaEvents || agendaEvents.length === 0) return '';

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // Filtrar eventos de hoy y mañana
  const todayEvents = [];
  const tomorrowEvents = [];
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  for (const evt of agendaEvents) {
    const evtDate = (evt.date || evt.startTime || '').substring(0, 10);
    if (evtDate === todayStr) todayEvents.push(evt);
    else if (evtDate === tomorrowStr) tomorrowEvents.push(evt);
  }

  const lines = [];
  if (todayEvents.length > 0) {
    lines.push(`📅 HOY tiene ${todayEvents.length} evento(s):`);
    for (const e of todayEvents) {
      const time = (e.date || e.startTime || '').substring(11, 16);
      lines.push(`  - ${time} → ${e.reason || e.title || 'Sin título'}${e.contactName ? ` (con ${e.contactName})` : ''}`);
    }
  }
  if (tomorrowEvents.length > 0) {
    lines.push(`📅 MAÑANA tiene ${tomorrowEvents.length} evento(s):`);
    for (const e of tomorrowEvents.slice(0, 3)) {
      const time = (e.date || e.startTime || '').substring(11, 16);
      lines.push(`  - ${time} → ${e.reason || e.title || 'Sin título'}`);
    }
  }

  // Detectar si el mensaje quiere agendar algo y hay conflicto potencial
  if (messageBody && /\b(agend|record|cita|reuni|turno)/i.test(messageBody)) {
    // Extraer hora mencionada
    const hourMatch = messageBody.match(/(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm|hs|hrs|h)?/i);
    if (hourMatch && todayEvents.length > 0) {
      let hour = parseInt(hourMatch[1]);
      const ampm = (hourMatch[3] || '').toLowerCase();
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;

      const conflicting = todayEvents.filter(e => {
        const evtHour = parseInt((e.date || e.startTime || '').substring(11, 13));
        return Math.abs(evtHour - hour) <= 1;
      });

      if (conflicting.length > 0) {
        lines.push(`⚠️ CONFLICTO POTENCIAL: Ya tiene evento(s) cerca de las ${hour}:00 → ${conflicting.map(e => e.reason || e.title).join(', ')}`);
      }
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

/**
 * Enriquecer con datos de afinidad
 * @param {object} opts - { affinityStage, affinityCount, contactName, lastContactDate, conversationMetadata }
 * @returns {string} Bloque de contexto de afinidad
 */
function enrichAffinity(opts) {
  const { affinityStage, affinityCount, contactName, lastContactDate, conversationMetadata } = opts;
  if (affinityStage === undefined && !lastContactDate) return '';

  const stageNames = ['Desconocido', 'Conocido', 'Confianza', 'Vínculo', 'Familia', 'HUMANA'];
  const lines = [];

  if (affinityStage !== undefined) {
    lines.push(`❤️ Afinidad con ${contactName || 'contacto'}: Stage ${affinityStage} (${stageNames[affinityStage] || '?'}) — ${affinityCount || 0} mensajes`);
  }

  // Calcular tiempo desde último contacto
  if (lastContactDate) {
    const lastDate = new Date(lastContactDate);
    const diffMs = Date.now() - lastDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays > 7) {
      lines.push(`⏰ Última conversación hace ${diffDays} días — retomar con cuidado, preguntar cómo está`);
    } else if (diffDays > 1) {
      lines.push(`⏰ Última conversación hace ${diffDays} días`);
    }
  }

  // Temas pendientes del metadata
  if (conversationMetadata) {
    const meta = conversationMetadata;
    if (meta.pendingTopic) {
      lines.push(`📌 Tema pendiente: ${meta.pendingTopic}`);
    }
    if (meta.lastTopic) {
      lines.push(`💬 Último tema: ${meta.lastTopic}`);
    }
  }

  return lines.join('\n');
}

/**
 * Enriquecer con datos de protección
 * @param {object} opts - { contactPhone, kidsProfiles, elderlyContacts, protectionLevel }
 * @returns {string} Bloque de contexto de protección
 */
function enrichProtection(opts) {
  const { contactPhone, kidsProfiles, elderlyContacts, protectionLevel } = opts;
  const lines = [];
  const basePhone = (contactPhone || '').split('@')[0];

  // Kids mode
  if (kidsProfiles && kidsProfiles[basePhone]) {
    const kid = kidsProfiles[basePhone];
    lines.push(`🧸 MODO KIDS ACTIVO — ${kid.name || 'Menor'}, ${kid.age || '?'} años`);
    lines.push(`  - Lenguaje simple, cariñoso, educativo`);
    lines.push(`  - NO hablar de temas adultos, violencia, política`);
    lines.push(`  - Máx 3 renglones, emojis amigables`);
  }

  // Elderly mode
  if (elderlyContacts && elderlyContacts[basePhone]) {
    const elder = elderlyContacts[basePhone];
    lines.push(`👴 CONTACTO PROTEGIDO (adulto mayor) — ${elder.name || 'Contacto'}`);
    lines.push(`  - Lenguaje claro, sin jerga, paciencia extra`);
    lines.push(`  - Si menciona sentirse mal → ALERTAR al owner`);
    if (elder.lastSeenAt) {
      const diffH = Math.floor((Date.now() - new Date(elder.lastSeenAt).getTime()) / 3600000);
      if (diffH > 12) {
        lines.push(`  - ⚠️ Sin actividad hace ${diffH} horas`);
      }
    }
  }

  // Nivel de emergencia
  if (protectionLevel && protectionLevel >= 2) {
    lines.push(`🚨 NIVEL DE EMERGENCIA ${protectionLevel}/3 — Priorizar seguridad del contacto`);
  }

  return lines.join('\n');
}

/**
 * Enriquecer con datos de ventas/lead
 * @param {object} opts - { isLead, contactName, leadData, trainingData, countryContext }
 * @returns {string} Bloque de contexto comercial
 */
function enrichSales(opts) {
  const { isLead, contactName, leadData, countryContext } = opts;
  if (!isLead) return '';

  const lines = [];

  if (leadData) {
    if (leadData.company) lines.push(`🏢 Empresa: ${leadData.company}`);
    if (leadData.country) lines.push(`🌍 País: ${leadData.country}`);
    if (leadData.users) lines.push(`👥 Usuarios mencionados: ${leadData.users}`);
    if (leadData.interest) lines.push(`🎯 Interés: ${leadData.interest}`);
    if (leadData.lastQuote) lines.push(`📄 Última cotización: ${leadData.lastQuote}`);
    if (leadData.stage) lines.push(`📊 Etapa: ${leadData.stage}`);
  }

  if (countryContext) {
    lines.push(`💱 ${countryContext}`);
  }

  return lines.length > 0 ? `[PERFIL COMERCIAL DEL LEAD: ${contactName || 'desconocido'}]\n${lines.join('\n')}` : '';
}

/**
 * Orquestador: ejecuta todos los enrichers y retorna bloque combinado
 * @param {object} opts - Todas las opciones necesarias
 * @returns {string} Bloque completo para inyectar en el prompt
 */
function runPreprocess(opts) {
  const blocks = [
    enrichProtection(opts),
    enrichAgenda(opts),
    enrichAffinity(opts),
    enrichSales(opts),
  ].filter(b => b.length > 0);

  if (blocks.length === 0) return '';

  return `\n[CONTEXTO ENRIQUECIDO POR SISTEMA — Datos reales, NO inventados]\n${blocks.join('\n\n')}\n[FIN CONTEXTO ENRIQUECIDO]\n`;
}

module.exports = {
  runPreprocess,
  enrichAgenda,
  enrichAffinity,
  enrichProtection,
  enrichSales,
};
