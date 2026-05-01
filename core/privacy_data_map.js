'use strict';

// MIIA -- Privacy Data Map (T91 mapa Mariano)
// Lista de categorias de datos que MIIA almacena por owner.
// Sin dependencias externas -- respuesta instantanea.

const DATA_CATEGORIES = [
  {
    name: 'conversations',
    description: 'Historial de conversaciones con contactos (leads, familia, equipo)',
    location: 'miia_persistent/tenant_conversations',
    retention: 'indefinida (hasta que el owner solicite eliminacion)',
    pii: true,
    pii_types: ['phone_numbers', 'message_content', 'names', 'contact_type'],
    access: 'owner-only via API'
  },
  {
    name: 'contact_types',
    description: 'Clasificacion de contactos (lead, familia, equipo, etc.) con TTL 30 dias',
    location: 'miia_persistent/tenant_conversations.contactTypes',
    retention: '30 dias de inactividad (TTL automatico)',
    pii: false,
    pii_types: [],
    access: 'owner-only via API'
  },
  {
    name: 'training_data',
    description: 'Instrucciones y patrones de voz del owner para personalizar MIIA',
    location: 'miia_persistent/training_data',
    retention: 'indefinida (propiedad del owner)',
    pii: false,
    pii_types: [],
    access: 'owner-only, editable via API'
  },
  {
    name: 'owner_profile',
    description: 'Perfil del negocio: nombre, ciudad, descripcion, configuracion MIIA',
    location: 'users/{uid}/profile',
    retention: 'indefinida (cuenta activa)',
    pii: true,
    pii_types: ['business_name', 'city', 'contact_info'],
    access: 'owner-only, editable via dashboard'
  },
  {
    name: 'personal_brain',
    description: 'Memoria personal del owner (solo MIIA Personal)',
    location: 'personal/personal_brain',
    retention: 'indefinida (cuenta activa)',
    pii: true,
    pii_types: ['personal_info', 'preferences', 'calendar_context'],
    access: 'owner-only'
  },
  {
    name: 'scheduled_messages',
    description: 'Mensajes y recordatorios programados pendientes de envio',
    location: 'miia_persistent/scheduled_messages',
    retention: 'hasta que se envien o el owner los cancele',
    pii: true,
    pii_types: ['phone_numbers', 'message_content', 'scheduled_time'],
    access: 'owner-only via API'
  },
  {
    name: 'ai_context_cache',
    description: 'Cache en memoria de contexto AI (no persistido en disco)',
    location: 'RAM (in-process, reinicio = limpieza)',
    retention: 'hasta reinicio del servicio',
    pii: false,
    pii_types: [],
    access: 'sistema interno'
  },
];

/**
 * Devuelve inventario de privacidad para un owner.
 * Sin acceso a Firestore -- respuesta instantanea.
 * @param {string} uid
 * @returns {object} inventario
 */
function getDataInventory(uid) {
  if (!uid) throw new Error('uid requerido');
  return {
    uid_masked: uid.length > 8 ? uid.slice(0, 8) + '...' : uid,
    generated_at: new Date().toISOString(),
    data_categories: DATA_CATEGORIES,
    summary: {
      total_categories: DATA_CATEGORIES.length,
      pii_categories: DATA_CATEGORIES.filter(c => c.pii).length,
      non_pii_categories: DATA_CATEGORIES.filter(c => !c.pii).length,
    },
    rights: [
      'Acceso: GET /api/tenant/:uid/privacy-report',
      'Portabilidad: GET /api/tenant/:uid/privacy-report (incluye export)',
      'Olvido: DELETE /api/privacy/forget-me (requiere confirmacion)',
      'Rectificacion: PATCH /api/tenant/:uid/profile'
    ],
    full_report_endpoint: '/api/tenant/:uid/privacy-report',
  };
}

module.exports = { getDataInventory, DATA_CATEGORIES };
