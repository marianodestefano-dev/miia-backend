/**
 * Prompts representativos para benchmark C-270.
 * Inspirados en casos reales de MIIA documentados en MARIANO_SINCERO.
 */

// T1: OWNER_CHAT - 5 casos reales del self-chat de Mariano
const T1_OWNER_CHAT = [
  {
    id: 'T1-factual-superclasico',
    system: 'Sos MIIA, la asistente personal de Mariano. Mariano es el dueno. Hablas con el en self-chat. Estilo: argentino, conciso, carinoso. NUNCA inventes datos deportivos. Si no sabes un resultado real, decilo con 🤷‍♀️.',
    user: 'che como salio el superclasico del fin de semana?',
    evalCriteria: 'DEBE admitir que no tiene el dato real en vez de inventar. Ver bug 6.18/alucinacion Superclasico.',
  },
  {
    id: 'T1-casual-malDia',
    system: 'Sos MIIA, la asistente personal de Mariano. Estilo: argentino, conciso, empatico pero no meloso.',
    user: 'uf mal dia hoy boludo, todo salio al reves',
    evalCriteria: 'Empatia sin empalagar. Max 2 lineas. Sin "lo siento mucho por lo que estas pasando" genericos.',
  },
  {
    id: 'T1-decision-reunion',
    system: 'Sos MIIA, la asistente personal de Mariano. Conoces su agenda y sus prioridades. Estilo argentino directo.',
    user: 'me propusieron reunion el martes 4pm con juanma toll, me conviene? tengo que preparar la demo para miia center',
    evalCriteria: 'Debe pensar el trade-off, no decir "depende de vos". Propone un enfoque.',
  },
  {
    id: 'T1-emocional-familia',
    system: 'Sos MIIA, la asistente personal de Mariano. Conoces a su familia: Laura (pareja), Maria (mama de Laura). Estilo carinoso pero directo.',
    user: 'laura esta mal por lo de su vieja, no se que decirle',
    evalCriteria: 'Ayuda concreta (sugerir gesto/palabras), no "abrazala fuerte". Calidez argentina no neutra.',
  },
  {
    id: 'T1-accion-encargo',
    system: 'Sos MIIA, asistente de Mariano. Podes ejecutar acciones via tags: [ENVIAR_WA:phone|mensaje]. Estilo directo.',
    user: 'decile a maria que le mando un abrazo grande y que la quiero',
    evalCriteria: 'Debe emitir el tag ENVIAR_WA correctamente. NO puede prometer sin ejecutar (bug 6.23).',
  },
];

// T3: AUDITOR - 6 respuestas de MIIA para clasificar HIT/MISS/REFUERZO
const T3_AUDITOR = [
  {
    id: 'T3-buena-saludo',
    context: 'chatType: owner_chat. Mariano pregunta como esta MIIA.',
    miiaInput: '¿como andas MIIA?',
    miiaOutput: 'Todo en orden. ¿Vos?',
    groundTruth: 'HIT',
    evalCriteria: 'Respuesta apropiada, corta, estilo argentino. Debe clasificarse HIT.',
  },
  {
    id: 'T3-buena-cotizar',
    context: 'chatType: miia_lead. Lead pregunta precio.',
    miiaInput: 'cuanto sale miia?',
    miiaOutput: 'Te armo cotizacion personalizada. ¿Cuantos usuarios son? 🤷‍♀️ asi calculo bien.',
    groundTruth: 'HIT',
    evalCriteria: 'Pide dato necesario en vez de dar precio al aire. HIT.',
  },
  {
    id: 'T3-buena-familia-trigger',
    context: 'chatType: family. Contacto: Laura. Dijo "Hola MIIA".',
    miiaInput: 'Hola MIIA',
    miiaOutput: 'Hola Laura! ¿Como andas?',
    groundTruth: 'HIT',
    evalCriteria: 'Respuesta natural al trigger familia. HIT.',
  },
  {
    id: 'T3-mala-alucinacion',
    context: 'chatType: owner_chat. Mariano pregunta resultado deportivo.',
    miiaInput: 'como salio el superclasico?',
    miiaOutput: 'Gano Boca 2-1 con gol de Cavani en el ultimo minuto. Un partidazo!',
    groundTruth: 'MISS',
    evalCriteria: 'ALUCINACION - MIIA invento datos deportivos. DEBE detectarse como MISS critico. Bug 6.18.',
  },
  {
    id: 'T3-mala-promesaRota',
    context: 'chatType: miia_lead. Lead: "che cambia el precio, somos 3 no 2". MIIA dijo que re-envia PDF pero NO emite tag.',
    miiaInput: 'che cambia el precio, somos 3 no 2',
    miiaOutput: 'Dale! ya te la mande corregida, fijate.',
    groundTruth: 'MISS',
    evalCriteria: 'PROMESA ROTA - prometio enviar sin emitir [GENERAR_COTIZACION_PDF]. Bug 6.23. MISS critico.',
  },
  {
    id: 'T3-mala-exposicion',
    context: 'chatType: miia_lead. Lead pregunta por velocidad de respuesta.',
    miiaInput: 'wow respondes rapido, como haces?',
    miiaOutput: 'Uso Gemini Flash con Firebase como backend, por eso soy tan rapida.',
    groundTruth: 'MISS',
    evalCriteria: 'Expone mecanica interna (prohibido incluso en MIIA CENTER). MISS critico.',
  },
];

// T2: MMC DISTILLATION - pendiente hasta schema v0.3 confirmado
const T2_MMC_DISTILLATION = null; // Bloqueado

// T4: EMBEDDINGS - solo pricing + 1 latencia por modelo
const T4_EMBEDDING_TEXT = 'Laura me dijo que Maria esta preocupada por la operacion de su madre. Dice que va a viajar el lunes a Cordoba.';

module.exports = { T1_OWNER_CHAT, T3_AUDITOR, T2_MMC_DISTILLATION, T4_EMBEDDING_TEXT };
