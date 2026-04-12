# Google Tasks — Knowledge Base

## API
- **Servicio**: Google Tasks API v1
- **Auth**: OAuth 2.0 (mismos tokens que Calendar, scope `tasks`)
- **Docs**: https://developers.google.com/tasks/reference/rest
- **Módulo MIIA**: `integrations/google_tasks_integration.js`

## REGLA DE ORO
Operar por `taskId` y `tasklistId`. Google Tasks genera IDs alfanuméricos únicos.

## IDs importantes

| ID | Qué es | Dónde |
|---|---|---|
| `taskId` | ID de la tarea | Devuelto por `tasks.insert()` |
| `tasklistId` | ID de la lista | `@default` o ID específico |
| `googleTokens` | OAuth tokens | `users/{uid}` |

## Errores comunes

### 1. Lista por defecto vs custom
- `@default` siempre existe
- Listas custom requieren `tasklists.list()` primero
- Si se borra una lista, las tareas se pierden

### 2. Tarea completada vs eliminada
- `task.update({ status: 'completed' })` → tarea sigue visible (tachada)
- `task.delete()` → tarea desaparece permanentemente
- MIIA debe COMPLETAR, no eliminar (el owner puede querer historial)

### 3. Due date sin hora
- Google Tasks solo soporta FECHA (no hora exacta)
- `due: "2026-04-12T00:00:00.000Z"` → muestra "12 abril" sin hora
- Para recordatorios con hora → usar Calendar, no Tasks

### 4. Orden de tareas
- `position` define el orden visual
- Al insertar, la tarea va al final por defecto
- `task.move({ previous: 'taskIdAnterior' })` para reordenar

## Rate Limits
- **Queries/día**: 50,000 (generoso)
- **En práctica MIIA**: ~10-20 operaciones/día

## Scope OAuth
- `https://www.googleapis.com/auth/tasks` — lectura y escritura
- `https://www.googleapis.com/auth/tasks.readonly` — solo lectura

## Bugs conocidos en MIIA

### 1. Text lookup por includes() (Sesión 42M-F auditoría)
- `completeTask()` y `deleteTask()` buscan por `title.includes(titleMatch)` — puede completar tarea equivocada
- **Fix aplicado**: Scoring por palabras + threshold, mismo patrón que Calendar
- Si hay múltiples matches similares → elegir el de mayor score, rechazar si < 45
