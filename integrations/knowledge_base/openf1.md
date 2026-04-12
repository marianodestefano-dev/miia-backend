# OpenF1 (Fórmula 1) — Knowledge Base

## API
- **Servicio**: OpenF1 API
- **Base URL**: `https://api.openf1.org/v1`
- **Auth**: NINGUNA (100% gratis, sin API key)
- **Docs**: https://openf1.org
- **Módulo MIIA**: `sports/adapters/f1_adapter.js`

## REGLA DE ORO
Operar por `session_key` y `driver_number`. Los IDs de OpenF1 son numéricos.

## IDs importantes

| ID | Qué es | Ejemplo |
|---|---|---|
| `session_key` | Sesión (práctica, quali, carrera) | `9574` |
| `meeting_key` | Gran Premio completo | `1245` |
| `driver_number` | Número permanente del piloto | `1` (Verstappen), `4` (Norris) |

## Endpoints que MIIA usa

| Endpoint | Qué devuelve | Uso |
|---|---|---|
| `/v1/sessions` | Lista de sesiones (pasadas/futuras) | Schedule |
| `/v1/position` | Posiciones en pista | Live tracking |
| `/v1/pit` | Paradas en pits | Eventos |
| `/v1/race_control` | Safety car, banderas | Incidentes |
| `/v1/drivers` | Lista de pilotos | Nombres |

## Errores comunes

### 1. Datos disponibles solo durante sesión activa
- `/position` y `/pit` solo tienen datos cuando hay sesión en vivo
- Fuera de sesión: devuelve datos de la última sesión
- **Fix**: Verificar `session_key` corresponde a sesión actual, no vieja

### 2. Delay de datos
- OpenF1 tiene delay de ~5-10 segundos vs transmisión TV
- Para F1, esto es aceptable (no es trading de alta frecuencia)

### 3. Session_key cambia cada sesión
- FP1, FP2, FP3, Quali, Sprint, Carrera → cada una tiene session_key diferente
- MIIA debe obtener el session_key correcto para la sesión actual

### 4. Temporada off-season
- De diciembre a febrero no hay sesiones
- MIIA no debe pollear durante off-season (waste de resources)

## Rate Limits
- **No documentados oficialmente**
- **Recomendado**: Max 60 req/min (1 req/segundo)
- **En práctica MIIA**: 4 req/min durante carrera (poll cada 15s) → OK

## Pilotos clave (2026)
- Verstappen: #1 (Red Bull)
- Colapinto: TBD (Williams/Alpine)
- Leclerc: #16 (Ferrari)
- Norris: #4 (McLaren)
- Hamilton: #44 (Ferrari)
