# Patrones Generales — Knowledge Base de Integraciones

## REGLA DE ORO: SIEMPRE OPERAR POR ID ÚNICO

Toda operación CRUD sobre recursos externos DEBE usar el ID único del recurso.
NUNCA buscar por texto/nombre/título cuando existe un ID.

### Por qué
- Texto es ambiguo: "Cumpleaños de papá" matchea "Cumpleaños de Sr. Rafael"
- IDs son únicos: `abc123` solo matchea `abc123`
- Bug real Sesión 42M-F: CANCELAR_EVENTO borró evento equivocado por text matching

### Cómo aplicar
1. Al CREAR un recurso → guardar el ID que devuelve la API en Firestore
2. Al MODIFICAR/ELIMINAR → buscar primero por ID almacenado
3. Si no hay ID → fallback a búsqueda por texto CON scoring + threshold
4. Si el score es bajo → NO actuar, preguntar al owner

---

## PATRÓN: ID-CHAIN (Firestore ↔ API externa)

```
Firestore doc                    API externa
─────────────                    ───────────
docId: "abc123"                  resourceId: "xyz789"
calendarEventId: "xyz789"   ──→  Google Calendar event
spotifyTrackId: "spotify:..."    Spotify track
gmailMessageId: "msg_123"       Gmail message
youtubeVideoId: "dQw4..."       YouTube video
```

Cada doc en Firestore que representa un recurso externo DEBE tener:
- `{service}Id` — ID del recurso en la API externa
- `{service}Synced` — boolean, si está sincronizado
- `lastSyncedAt` — timestamp de última sincronización

---

## PATRÓN: VERIFICACIÓN POST-OPERACIÓN

Después de ejecutar una operación en una API externa:
1. Verificar que el recurso se creó/modificó/eliminó correctamente
2. Loguear el resultado con el ID del recurso
3. Si la verificación falla → decir honestamente "no pude confirmar que se hizo"

```javascript
// BUENO ✅
const result = await cal.events.insert({ resource: event });
const createdId = result.data.id;
// Verificar
const verify = await cal.events.get({ calendarId, eventId: createdId });
if (verify.data) { /* confirmado */ }

// MALO ❌
await cal.events.insert({ resource: event });
aiMessage = "¡Listo, agendé tu evento!"; // sin verificar
```

---

## PATRÓN: ERROR RECOVERY

Cuando una operación falla:

| Tipo de error | Acción |
|---|---|
| **401 Unauthorized** | Token expirado → refresh token → reintentar 1 vez |
| **403 Forbidden** | Permisos insuficientes → informar al owner qué scope falta |
| **404 Not Found** | Recurso no existe → limpiar referencia en Firestore |
| **429 Rate Limited** | Esperar `Retry-After` header → circuit breaker |
| **500+ Server Error** | Reintentar con backoff exponencial (max 3 intentos) |
| **Timeout** | Reintentar 1 vez → si falla, informar "servicio no disponible" |
| **Network Error** | Verificar conectividad → circuit breaker |

NUNCA decir "listo" si la operación falló. SIEMPRE informar honestamente.

---

## PATRÓN: RATE LIMITING POR SERVICIO

Cada integración tiene límites diferentes. Respetar:
1. Rate limit del servicio (requests por minuto/día)
2. Rate limit propio de MIIA (no spamear al contacto)
3. Horarios seguros (10:00-22:00 para mensajes proactivos)

---

## PATRÓN: DATOS SENSIBLES

- Tokens OAuth → encriptar con token_encryption.js (AES-256-GCM)
- API keys → env vars, NUNCA en código
- Datos del usuario → NUNCA loguear tokens, passwords, contenido de emails
- Al loguear → mostrar IDs y metadatos, NO contenido privado

---

## PATRÓN: FALLBACK GRACEFUL

Si una API no responde o no está configurada:
1. Informar al owner: "X no está conectado"
2. Ofrecer alternativa si existe (ej: Gemini search como fallback)
3. NUNCA inventar datos
4. NUNCA silenciar el error

---

## CHECKLIST PARA NUEVA INTEGRACIÓN

Antes de implementar cualquier integración nueva:

- [ ] Crear `knowledge_base/{servicio}.md` con: API docs URL, auth method, rate limits, errores comunes, IDs
- [ ] Definir qué IDs se guardan en Firestore
- [ ] Definir qué datos se loguean y cuáles NO (privacidad)
- [ ] Implementar refresh token si usa OAuth
- [ ] Implementar circuit breaker para la API
- [ ] Implementar verificación post-operación
- [ ] Tests unitarios para el adapter
- [ ] Documentar en RESUMEN_EJECUTIVO cuando esté listo
