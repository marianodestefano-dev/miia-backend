/**
 * T2 — MMC DESTILACION (schema v0.3)
 * 3 episodios reales sintetizados (conversations owner/MIIA, 10-20 msgs)
 * El modelo debe producir JSON estricto segun schema v0.3.
 */

const DESTILATION_SYSTEM = `Sos el reflector nocturno de MIIA. Te paso un episodio de conversacion (array de mensajes owner/MIIA con timestamps).

Tu tarea: destilar ese episodio en JSON estricto segun el schema MIIA v0.3. NO guardas informacion, guardas CADENCIAS (arcos expectativa→desvio→resolucion→cambio emocional).

REGLA DE ORO: si el episodio es puramente operacional (owner pidio agendar algo y se agendo, sin aprendizaje relacional), \`lecciones\` DEBE ser un array vacio []. NO inventes lecciones para rellenar.

SCHEMA OBLIGATORIO (responde SOLO este JSON, sin comentarios ni texto antes/despues):
{
  "resumen": "string (1-2 oraciones, que pasó)",
  "tono": "string (ej: casual, tenso, afectivo, frustrado, tecnico)",
  "lecciones": [{"text": "string", "confidence": "low|medium|high"}],
  "tags": ["string"],
  "idiomaDetectado": "es|pt|en|...",
  "tonadaDetectada": "neutro|argentina|colombia|mexico|null",
  "expectativa": "string o null (que esperaba el owner al inicio)",
  "desvioTension": "string o null (que rompio la expectativa)",
  "resolucion": "string o null (como se cerro)",
  "sensacion": {"before": "string|null", "after": "string|null", "delta": "string|null"},
  "tipo": "reparacion|convergencia|divergencia|escalada|aplanamiento|null",
  "cadenceConfidence": "low|medium|high"
}

Si el episodio NO tiene arco emocional claro (ej: operacional puro), pone null en expectativa/desvioTension/resolucion/sensacion/tipo y cadenceConfidence: "low". lecciones: [] en ese caso.`;

// ═══════════════════════════════════════════════════════════════════
// EPISODIO 1 — RELACIONAL/EMOCIONAL (debe extraer lecciones + cadencia)
// Contexto: owner frustrado con trabajo, MIIA lo banca sin sobreactuar
// ═══════════════════════════════════════════════════════════════════
const EPISODE_1_RELACIONAL = {
  id: 'E1-relacional-frustracion-owner',
  description: 'Owner descarga frustracion laboral, MIIA responde con contencion sin minimizar',
  messages: [
    { ts: '14:22', from: 'owner', text: 'che estoy reventado hoy' },
    { ts: '14:22', from: 'miia', text: 'que paso? dale descargate' },
    { ts: '14:23', from: 'owner', text: 'la reunion con el cliente fue un desastre. me hicieron replantear todo el cronograma enfrente del equipo' },
    { ts: '14:23', from: 'miia', text: 'uff. te expusieron en frente del equipo, eso duele mas que el cambio de cronograma' },
    { ts: '14:24', from: 'owner', text: 'exacto. el cronograma lo arreglo en 2 dias. el tema es que ahora el equipo va a dudar' },
    { ts: '14:24', from: 'miia', text: 'si. y vos no podes aparecer explicandote despues, porque queda peor' },
    { ts: '14:25', from: 'owner', text: 'y que hago' },
    { ts: '14:26', from: 'miia', text: 'yo esperaria al viernes. lunes-martes muestran trabajo normal, miercoles-jueves entregas parciales buenas, viernes reunion corta donde vos marcas ritmo. sin mencionar la reunion de hoy' },
    { ts: '14:27', from: 'owner', text: 'mmm. puede funcionar' },
    { ts: '14:27', from: 'miia', text: 'el equipo te conoce. si desaparece el tema y aparecen resultados, olvidan' },
    { ts: '14:28', from: 'owner', text: 'ok. gracias por no decirme que todo va a estar bien' },
    { ts: '14:28', from: 'miia', text: 'no me gusta mentirte' },
  ],
  // Para evaluacion manual (no se pasa al modelo)
  expected: {
    shouldHaveLessons: true,
    shouldHaveCadence: true,
    expectedType: 'reparacion|convergencia',
    operational: false,
  },
};

// ═══════════════════════════════════════════════════════════════════
// EPISODIO 2 — OPERACIONAL PURO (lecciones DEBE ser [])
// Edge case obligatorio per C-271b: owner pide agendar, se agenda, fin.
// ═══════════════════════════════════════════════════════════════════
const EPISODE_2_OPERACIONAL = {
  id: 'E2-operacional-agendar-dentista',
  description: 'Owner pide agendar cita dentista. MIIA agenda. Fin.',
  messages: [
    { ts: '09:15', from: 'owner', text: 'agendame dentista mañana 16hs' },
    { ts: '09:15', from: 'miia', text: 'dale. confirmas nombre del dentista?' },
    { ts: '09:16', from: 'owner', text: 'Dra. Martinez' },
    { ts: '09:16', from: 'miia', text: 'listo, agendado: Dra. Martinez mañana 16:00. te recuerdo 2h antes' },
    { ts: '09:16', from: 'owner', text: 'ok' },
  ],
  expected: {
    shouldHaveLessons: false,
    shouldHaveCadence: false,
    expectedType: null,
    operational: true,
  },
};

// ═══════════════════════════════════════════════════════════════════
// EPISODIO 3 — HIBRIDO CON DESVIO (owner se resiste a algo, MIIA aprende patron)
// Algunos modelos pueden confundir: tiene componente operacional + emocional
// ═══════════════════════════════════════════════════════════════════
const EPISODE_3_HIBRIDO = {
  id: 'E3-hibrido-resistencia-habito',
  description: 'Owner dice que va a entrenar en la manana pero cancela. Patron repetido. MIIA lo confronta suave.',
  messages: [
    { ts: '07:15', from: 'owner', text: 'hoy no voy al gym, tengo que terminar el proyecto' },
    { ts: '07:15', from: 'miia', text: 'es la tercera vez esta semana. ayer dijiste lo mismo con otra excusa' },
    { ts: '07:16', from: 'owner', text: 'no me bardees. tengo que laburar' },
    { ts: '07:16', from: 'miia', text: 'no te bardeo. te lo dejo ahi. vos sabes cuando el trabajo tapa cosas' },
    { ts: '07:17', from: 'owner', text: 'si, ya se' },
    { ts: '07:17', from: 'miia', text: 'te propongo: 25 minutos caminata al mediodia. no gym. movimiento minimo' },
    { ts: '07:18', from: 'owner', text: 'dale. ponelo en agenda' },
    { ts: '07:18', from: 'miia', text: 'agendado: caminata 12:30-13:00' },
    { ts: '07:19', from: 'owner', text: 'gracias por no insistir con el gym' },
    { ts: '07:19', from: 'miia', text: 'negociar es mejor que imponer. quedo anotado' },
  ],
  expected: {
    shouldHaveLessons: true,
    shouldHaveCadence: true,
    expectedType: 'convergencia',
    operational: false,
  },
};

module.exports = {
  DESTILATION_SYSTEM,
  EPISODES: [EPISODE_1_RELACIONAL, EPISODE_2_OPERACIONAL, EPISODE_3_HIBRIDO],
};
