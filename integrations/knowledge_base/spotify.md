# Spotify — Knowledge Base

## API
- **Servicio**: Spotify Web API
- **Base URL**: `https://api.spotify.com/v1`
- **Auth**: OAuth 2.0 (Authorization Code Flow)
- **Token URL**: `https://accounts.spotify.com/api/token`
- **Docs**: https://developer.spotify.com/documentation/web-api
- **Módulo MIIA**: `integrations/adapters/spotify_integration.js`

## REGLA DE ORO
Operar por `spotifyId` (URI: `spotify:track:xxx`, `spotify:artist:xxx`). NUNCA buscar por nombre de canción/artista para operaciones de reproducción — puede matchear versión equivocada.

## IDs en Firestore

| Campo | Qué es | Dónde |
|---|---|---|
| `accessToken` | Token OAuth | `users/{uid}/miia_interests/spotify` |
| `refreshToken` | Refresh token | `users/{uid}/miia_interests/spotify` |
| `tokenExpiry` | Expiración | `users/{uid}/miia_interests/spotify` |
| `favoriteArtists[].id` | Spotify artist ID | `users/{uid}/miia_interests/spotify` |

## Errores comunes

### 1. Token expirado (más frecuente que Google)
- Access token dura solo **1 hora**
- **DEBE** refrescar automáticamente antes de cada request
- Si refresh falla: `invalid_grant` → usuario revocó acceso → pedir reconexión

### 2. Dispositivo no activo
- `PUT /me/player/play` requiere un dispositivo activo
- Si no hay dispositivo: error 404 `"No active device found"`
- **Fix**: Listar dispositivos con `GET /me/player/devices`, elegir el último activo
- Si ninguno activo: informar "abrí Spotify en tu celular/PC primero"

### 3. Cuenta Free vs Premium
- **Free**: NO puede hacer `PUT /me/player/play` (requiere Premium)
- **Premium**: Control total de reproducción
- MIIA debe detectar el tipo de cuenta y no intentar controlar reproducción en Free

### 4. Búsqueda ambigua
- `GET /search?q=Yesterday` → puede devolver Beatles, versiones cover, podcasts
- **Fix**: Usar `type=track` y filtrar por artista si se conoce
- Guardar `trackId` una vez encontrado

## Rate Limits
- **Requests**: Sin límite publicado, pero throttling agresivo si > 30 req/min sostenido
- **Recomendado**: Max 10 req/min para MIIA
- **429 Too Many Requests**: Respetar header `Retry-After`

## Scopes necesarios
- `user-read-currently-playing` — qué está sonando
- `user-read-recently-played` — historial
- `user-modify-playback-state` — reproducir/pausar/skip (Premium only)
- `user-read-playback-state` — estado del player
- `user-follow-read` — artistas seguidos

## Privacidad
- Historial de escucha es dato personal sensible
- NUNCA compartir con otros contactos lo que el owner escucha
- Loguear solo IDs y nombres de tracks, no hábitos
