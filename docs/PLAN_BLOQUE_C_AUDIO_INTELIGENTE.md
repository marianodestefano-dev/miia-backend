# PLAN BLOQUE C: Audio Inteligente

**Fecha**: 2026-04-03
**Standard**: Google + Amazon + NASA
**Estimación**: 6-10 horas
**Dependencias**: Ninguna (independiente, se puede hacer antes o después de B)

---

## CONCEPTO

MIIA maneja audio de forma inteligente en DOS direcciones:
1. **Recibir audio** → Transcribir (YA EXISTE en `processMediaMessage`, server.js:2252)
2. **Enviar audio** → Text-to-Speech con voz personalizable (NUEVO)
3. **Audio clips guardados** → Owner graba clips desde dashboard, MIIA los envía por keyword match (NUEVO)

---

## C1: Audio Clips Guardados (Owner graba desde Dashboard)

### Concepto
El owner puede grabar/subir clips de audio desde el dashboard web. Cada clip se asocia a keywords.
Cuando MIIA detecta que un mensaje matchea keywords de un clip, lo envía como nota de voz.

### Firestore Structure
```
users/{uid}/audio_clips/{clipId}
├── name: string          // "Saludo bienvenida"
├── keywords: string[]    // ["hola", "buen día", "buenos días"]
├── storage_url: string   // Firebase Storage URL
├── duration_ms: number   // 4500
├── mimetype: string      // "audio/ogg; codecs=opus"
├── created_at: timestamp
├── updated_at: timestamp
├── enabled: boolean      // toggle on/off sin borrar
├── scope: string         // "all" | "leads" | "grupo" | businessId
└── play_count: number    // estadísticas
```

### Firebase Storage Path
```
users/{uid}/audio_clips/{clipId}.ogg
```

### Backend Endpoints (server.js o routes/audio_clips.js)
```
POST   /api/tenant/:uid/audio-clips          → upload clip (multipart/form-data)
GET    /api/tenant/:uid/audio-clips           → list all clips
PUT    /api/tenant/:uid/audio-clips/:clipId   → update name/keywords/enabled/scope
DELETE /api/tenant/:uid/audio-clips/:clipId   → delete clip + storage file
GET    /api/tenant/:uid/audio-clips/:clipId/audio → stream audio file (para preview)
```

### Upload Flow
1. Frontend graba audio via MediaRecorder API (formato webm/opus)
2. Backend recibe multipart → convierte a OGG/OPUS (ffmpeg o dejar webm)
3. Sube a Firebase Storage → guarda URL en Firestore
4. Baileys envía como `{ audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }`

### Keyword Matching (en handleIncomingMessage)
```javascript
async function findMatchingAudioClip(uid, messageBody, contactType) {
  // 1. Cargar clips del cache (no Firestore en cada mensaje)
  // 2. Filtrar por enabled=true y scope compatible
  // 3. Para cada clip, verificar si alguna keyword está en messageBody
  // 4. Si match → retornar clip info (URL para descargar)
  // 5. Si no → null (MIIA responde texto normal)
}
```

### Cache Strategy
- Cargar clips al iniciar tenant / al conectar
- Invalidar cache en CRUD endpoints
- Map: `audioClipsCache[uid] = Map<clipId, clipDoc>`

### Integración en flujo de mensajes
Punto de inserción: **DESPUÉS** de que Gemini genera respuesta, **ANTES** de enviar.
```
handleIncomingMessage
  → Gemini genera respuesta texto
  → ¿Hay audio clip que matchea el mensaje ENTRANTE? 
    → SÍ: enviar audio clip + texto de Gemini como caption (o solo audio)
    → NO: enviar texto normal
```

**Decisión pendiente para Mariano**: ¿El clip reemplaza el texto, o se envía ADEMÁS del texto?

### Frontend (owner-dashboard.html o nueva sección)
- Tab "Audio Clips" en sidebar o dentro de Training
- Lista de clips con: nombre, keywords, toggle enabled, preview (play), delete
- Botón "Grabar nuevo" → MediaRecorder popup
- Botón "Subir archivo" → file input (accept="audio/*")
- Editor de keywords (chips/tags)
- Selector de scope: "Todos", "Solo leads", "Solo grupo", o negocio específico

---

## C2: Text-to-Speech — MIIA Envía Audio Generado

### Concepto (Fase futura — ver TAREA_PENDIENTE_VOZ_MIIA.md)
MIIA convierte su respuesta texto a audio y envía nota de voz.
- Leads: voz clonada del owner (ElevenLabs)
- Grupo: voz propia de MIIA (elegida por owner)

### Proveedores TTS
| Proveedor | Clone | Costo | Latencia |
|-----------|-------|-------|----------|
| ElevenLabs | ✅ Sí (30s grabación) | $5-22/mes | ~1-3s |
| OpenAI TTS | ❌ Predefinidas | ~$15/1M chars | ~1-2s |
| Google Cloud TTS | ❌ Predefinidas | ~$4/1M chars | ~0.5-1s |

### Firestore Config
```
users/{uid}/settings/voice
├── tts_provider: string        // "elevenlabs" | "openai" | "google"
├── tts_api_key: string         // encrypted
├── voice_lead: string          // voice_id para leads (clonada)
├── voice_group: string         // voice_id para grupo
├── voice_enabled: boolean      // toggle global
├── voice_mode: string          // "auto" | "manual" | "keywords"
│   // auto: MIIA decide cuándo audio vs texto
│   // manual: solo cuando MIIA dice [ENVIAR_AUDIO]
│   // keywords: solo respuestas a mensajes de audio entrantes
└── clone_sample_url: string    // grabación del owner en Storage
```

### Función TTS
```javascript
async function generateTTSAudio(text, voiceId, provider, apiKey) {
  // 1. Llamar API del proveedor
  // 2. Recibir buffer de audio
  // 3. Convertir a OGG/OPUS si necesario (Baileys ptt requiere opus)
  // 4. Retornar { buffer, mimetype, duration_ms }
}
```

### Integración en flujo
```
processMiiaResponse / processTenantResponse
  → Gemini genera texto
  → ¿voice_enabled && condición del voice_mode?
    → SÍ: generateTTSAudio(texto, voiceId, provider, apiKey)
           → Baileys envía { audio: buffer, ptt: true }
    → NO: enviar texto normal
```

### Decisiones de cuándo enviar audio (mode "auto")
MIIA decide enviar audio cuando:
- El contacto envió un audio (reciprocidad)
- El mensaje es emocional/personal (no datos/números)
- El contacto tiene historial de preferir audios
- La respuesta es corta (< 200 chars — audios largos cansan)

### Este bloque es Fase K (futura)
Solo C1 (clips guardados) se implementa ahora. C2 (TTS) queda documentado para cuando Mariano lo pida.

---

## C3: Mejora de Transcripción Existente

### Estado actual
- `processMediaMessage` (server.js:2252) descarga audio → Gemini Flash transcribe
- Funciona, pero prompt es genérico: "Transcribí textualmente este audio al español"

### Mejoras propuestas
1. **Detección de idioma**: Si el audio no es en español, transcribir en idioma original + traducción
2. **Contexto en transcripción**: Incluir nombre del contacto y contexto del negocio en el prompt de Gemini para mejor accuracy (nombres propios, términos del rubro)
3. **Fallback**: Si Gemini falla, intentar con Whisper API de OpenAI ($0.006/min)
4. **Log de calidad**: Registrar ratio audio-recibido/audio-transcrito-exitosamente

### Cambios en processMediaMessage
```javascript
function getMediaPrompt(mimetype, contactName, businessContext) {
  if (mimetype.startsWith('audio/'))
    return `Transcribí textualmente este audio. El hablante es ${contactName || 'desconocido'}. ` +
           `Contexto: ${businessContext || 'asistente virtual'}. ` +
           `Si el audio está en otro idioma, transcribí en ese idioma y agregá traducción al español entre paréntesis.`;
  // ... resto igual
}
```

---

## Orden de Implementación

| Sub-bloque | Qué | Estimación | Prioridad |
|------------|-----|-----------|-----------|
| C1 | Audio clips guardados (backend endpoints) | 3-4h | Alta |
| C1 | Audio clips guardados (frontend UI) | 2-3h | Alta |
| C1 | Keyword matching en flujo de mensajes | 1-2h | Alta |
| C3 | Mejora transcripción | 0.5h | Media |
| C2 | TTS (diseño listo, implementar en Fase K) | 4-6h | Futura |

---

## Archivos Afectados

| Archivo | Cambio |
|---------|--------|
| `server.js` | Endpoints CRUD audio clips + keyword matching hook |
| `processMediaMessage` (server.js:2252) | Mejora prompt transcripción |
| `owner-dashboard.html` | Tab/sección audio clips |
| `admin-dashboard.html` | Misma funcionalidad para admin |
| Firebase Storage | Nuevo bucket/path para audio clips |
| `package.json` | (opcional) ffmpeg-static si se necesita conversión |

---

## Riesgos y Mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| Firebase Storage costo | Límite: 50 clips por owner, 10MB max por clip |
| MediaRecorder no soportado en browser viejo | Fallback: upload file input |
| Formato audio incompatible con Baileys | Convertir siempre a OGG/OPUS server-side |
| Keyword matching falsos positivos | Keywords deben ser 2+ palabras o frases únicas |
| Latencia de descarga de clip para enviar | Mantener buffer en RAM cache (clips son pequeños) |

---

*Documento generado — Sesión 9, 2026-04-03*
