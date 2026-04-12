# YouTube Data API — Knowledge Base

## API
- **Servicio**: YouTube Data API v3
- **Base URL**: `https://www.googleapis.com/youtube/v3`
- **Auth**: API Key (no OAuth para lectura pública)
- **Docs**: https://developers.google.com/youtube/v3/docs
- **Módulo MIIA**: `integrations/adapters/youtube_integration.js`

## REGLA DE ORO
Operar por `videoId` y `channelId`. Los IDs de YouTube son strings cortos alfanuméricos (ej: `dQw4w9WgXcQ`).

## IDs en Firestore

| Campo | Qué es | Dónde |
|---|---|---|
| `channels[].id` | YouTube channel ID | `users/{uid}/miia_interests/youtube` |
| `channels[].name` | Nombre del canal | `users/{uid}/miia_interests/youtube` |
| `apiKey` | YouTube API Key | `users/{uid}/miia_interests/youtube` o env |
| `lastChecked` | Última verificación | `users/{uid}/miia_interests/youtube` |

## Errores comunes

### 1. CUOTA EXCEDIDA (el más crítico)
- **Cuota diaria**: 10,000 unidades/día (GRATUITO)
- `search.list` = **100 unidades** por request (¡carísima!)
- `videos.list` = **1 unidad**
- `channels.list` = **1 unidad**
- **Con 10 canales, 4 checks/día**: 10 × 4 × 100 = 4,000 unidades/día = OK
- **Con 50 canales**: 50 × 4 × 100 = 20,000 → EXCEDE CUOTA

### 2. Optimización de cuota
- Usar `search.list` con `publishedAfter` para filtrar solo videos nuevos
- Cachear resultados: si el canal no tiene video nuevo, no re-buscar por 6 horas
- Alternativa gratis: RSS feed del canal (`https://www.youtube.com/feeds/videos.xml?channel_id=XXXX`) — 0 cuota

### 3. Channel ID vs Username
- `channelId` es `UCxxxx...` (estable, permanente)
- Username (`@canal`) puede cambiar
- SIEMPRE guardar `channelId`, no username

### 4. Videos privados/eliminados
- Si un video se elimina, `videos.list` devuelve vacío
- NO crashear, simplemente omitir

## Rate Limits
- **Cuota diaria**: 10,000 unidades (gratis), ampliable pagando
- **Requests/segundo**: 100
- **Costo por unidad extra**: $0 (pero requiere solicitar aumento)

## Privacidad
- Los datos de YouTube son públicos (títulos, thumbnails, fechas)
- Las preferencias del owner (qué canales sigue) son privadas
- NUNCA compartir qué canales sigue el owner con leads/contactos
