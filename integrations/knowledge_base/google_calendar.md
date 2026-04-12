# Google Calendar — Knowledge Base

## API
- **Servicio**: Google Calendar API v3
- **Auth**: OAuth 2.0 (tokens en Firestore `users/{uid}.googleTokens`)
- **Docs**: https://developers.google.com/calendar/api/v3/reference
- **Módulo MIIA**: `core/google_calendar.js`

## REGLA DE ORO
SIEMPRE operar por `eventId`, NUNCA por texto. Guardar `calendarEventId` en Firestore al crear.

## IDs que se guardan en Firestore

| Campo Firestore | Qué es | Dónde |
|---|---|---|
| `calendarEventId` | ID del evento en Google Calendar | `users/{uid}/miia_agenda/{docId}` |
| `calendarSynced` | Si el evento está sincronizado con Calendar | `users/{uid}/miia_agenda/{docId}` |
| `googleTokens` | OAuth tokens (access + refresh) | `users/{uid}` (root doc) |

## Errores conocidos (bugs reales de MIIA)

### 1. Text search ambiguo (Sesión 42M-F)
- **Qué pasó**: `cal.events.list({ q: "Cumpleaños" })` devolvió 2 eventos, se borró el equivocado
- **Causa**: El parámetro `q` es fuzzy, matchea parcialmente
- **Fix**: Guardar `calendarEventId` y operar por ID directo. Text search solo como fallback.

### 2. Minutos se perdían (Sesión 42M-F)
- **Qué pasó**: "6:45am" se creaba como "6:00am" en Calendar
- **Causa**: `createCalendarEvent` solo aceptaba `startHour` (entero), no minutos
- **Fix**: Agregado `startMinute`/`endMinute` a la función

### 3. MOVER no movía en Calendar (Sesión 42M-F)
- **Qué pasó**: `MOVER_EVENTO` solo actualizaba Firestore, Calendar seguía con la hora vieja
- **Causa**: No había código para `cal.events.patch()`
- **Fix**: Agregado patch por `calendarEventId` (fast-path) + text search (fallback)

### 4. movedFrom undefined (Sesión 42M-F)
- **Qué pasó**: Eventos viejos no tenían `scheduledForLocal` → Firestore rechaza `undefined`
- **Fix**: Fallback chain `scheduledForLocal || scheduledFor || oldDate || 'desconocido'`

## Rate Limits
- **Queries/día**: 1,000,000 (proyecto)
- **Inserts/segundo**: 500
- **En práctica**: MIIA hace ~50-100 operaciones/día, muy dentro del límite

## OAuth Gotchas
- Access token expira en **1 hora** → usar refresh token automático
- Scope necesario: `calendar.events` (NO incluye `calendar.settings`)
- Si refresh falla → `googleTokens` en Firestore queda inválido → pedir reconexión al owner
- Error `invalid_grant`: token revocado por el usuario → limpiar y pedir reconexión

## Operaciones y sus IDs

| Operación | Método | ID necesario |
|---|---|---|
| Crear evento | `cal.events.insert()` | Devuelve `response.data.id` → GUARDAR |
| Leer evento | `cal.events.get()` | `eventId` obligatorio |
| Mover evento | `cal.events.patch()` | `eventId` obligatorio |
| Borrar evento | `cal.events.delete()` | `eventId` obligatorio |
| Listar eventos | `cal.events.list()` | Solo `calendarId` ("primary") |
| Buscar por texto | `cal.events.list({ q: ... })` | ⚠️ FUZZY, usar solo como fallback |

## Formato de fechas
- Google Calendar espera: `YYYY-MM-DDTHH:MM:SS` con `timeZone`
- SIEMPRE incluir `timeZone` explícito (ej: `America/Bogota`)
- Sin timezone → Calendar usa UTC → hora incorrecta para el usuario

## Duplicados
- Calendar NO previene duplicados automáticamente
- MIIA debe verificar si ya existe un evento similar antes de crear uno nuevo
- Si hay duplicados: borrar solo el último (probable duplicado), no el original
