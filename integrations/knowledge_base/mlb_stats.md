# MLB Stats API — Knowledge Base

## API
- **Servicio**: MLB Stats API
- **Base URL**: `https://statsapi.mlb.com`
- **Auth**: NINGUNA (100% gratis, sin API key)
- **Docs**: No oficial, pero bien documentada en comunidad
- **Módulo MIIA**: `sports/adapters/mlb_adapter.js`

## REGLA DE ORO
Operar por `gamePk` (ID único del partido). Cada partido tiene un feed live con ID estable.

## IDs importantes

| ID | Qué es | Ejemplo |
|---|---|---|
| `gamePk` | ID único del partido | `745832` |
| `teamId` | ID del equipo | `147` (Yankees) |
| `personId` | ID del jugador | `660271` (Ohtani) |

## Endpoints que MIIA usa

| Endpoint | Qué devuelve |
|---|---|
| `/api/v1/schedule?date=YYYY-MM-DD` | Partidos del día |
| `/api/v1.1/game/{gamePk}/feed/live` | Estado en vivo del partido |
| `/api/v1/teams` | Lista de equipos con IDs |

## Errores comunes

### 1. Timezone de partidos
- Horarios en ET (Eastern Time) por defecto
- MIIA debe convertir a timezone del owner
- Un partido a las 7:05 PM ET = 6:05 PM Colombia

### 2. Juegos suspendidos/pospuestos
- `status.statusCode: "S"` = suspendido, `"D"` = diferido
- MIIA no debe reportar resultados de juegos no completados como finales

### 3. Doubleheaders
- Mismo equipo, mismo día, 2 partidos
- Tienen `gameNumber: 1` y `gameNumber: 2`
- MIIA debe distinguir cuál es cuál

## Rate Limits
- **No documentados** (API gratuita pública)
- **Recomendado**: Max 30 req/min
- **En práctica MIIA**: ~2-4 req/min durante juego → OK

## Temporada
- Regular: Abril — Septiembre
- Playoffs: Octubre
- Off-season: Noviembre — Marzo (no pollear)
