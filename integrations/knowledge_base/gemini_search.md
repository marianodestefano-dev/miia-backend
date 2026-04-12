# Gemini google_search — Knowledge Base

## API
- **Servicio**: Google Gemini API con tool `google_search`
- **Auth**: API Key (env: `GEMINI_API_KEY`)
- **Docs**: https://ai.google.dev/docs
- **Módulo MIIA**: `core/ai_gateway.js`

## REGLA DE ORO
Gemini google_search es el FALLBACK universal para integraciones sin API directa.
MIIA lo usa para: clima, noticias, stocks, fútbol, tenis, NBA, UFC, rugby, boxeo, golf, ciclismo.

**RIESGO PRINCIPAL**: Gemini puede INVENTAR datos si google_search no encuentra resultados actuales. SIEMPRE instruir en el prompt: "SI NO ENCONTRÁS DATOS REALES, decí que no pudiste obtenerlos."

## Qué integraciones lo usan

| Integración | API directa | Gemini search |
|---|---|---|
| F1 | OpenF1 (gratis) | NO |
| MLB | statsapi.mlb.com (gratis) | NO |
| YouTube | YouTube Data API | NO |
| Gmail | Gmail API | NO |
| Spotify | Spotify Web API | NO |
| **Fútbol** | — | **SÍ** |
| **Tenis** | — | **SÍ** |
| **NBA** | — | **SÍ** |
| **UFC** | — | **SÍ** |
| **Rugby** | — | **SÍ** |
| **Boxeo** | — | **SÍ** |
| **Golf** | — | **SÍ** |
| **Ciclismo** | — | **SÍ** |
| **Clima** | — | **SÍ** |
| **Noticias** | — | **SÍ** |
| **Stocks/Crypto** | — | **SÍ** |

## Errores comunes

### 1. Alucinación de datos
- **El problema más grave**: Si google_search no encuentra el resultado de un partido, Gemini puede inventar el score
- **Fix en prompt**: "REGLA ABSOLUTA: Si google_search no devuelve datos concretos, responde 'No pude obtener datos en tiempo real'. NUNCA inventes scores, precios, o estadísticas."

### 2. Datos desactualizados
- google_search puede devolver resultados de hace horas/días
- Un "partido en vivo" puede mostrar resultado de ayer
- **Fix**: Incluir fecha exacta en la query: "resultado River Plate HOY 12 de abril 2026"

### 3. Resultados de otro deporte/equipo
- "Boca" puede matchear "Boca Juniors" o "Boca Raton"
- **Fix**: Ser específico: "Boca Juniors fútbol argentino resultado hoy"

### 4. Rate limit del free tier
- **Free**: 15 RPM (requests per minute), 1,500 RPD (per day)
- **Con 8 deportes + clima + noticias + stocks**: ~40-50 req/hora max
- **Riesgo**: Durante día con muchos eventos simultáneos → puede exceder 15 RPM
- **Fix**: Cola de prioridad + throttling

## Rate Limits detallados

| Tier | RPM | RPD | Costo |
|---|---|---|---|
| Free | 15 | 1,500 | $0 |
| Pay-as-you-go | 2,000 | ilimitado | ~$0.075/1M input tokens |

## Best Practices para prompts de búsqueda
1. Incluir fecha exacta
2. Incluir país/liga para deportes
3. Incluir moneda para precios
4. Pedir formato estructurado (score: X-Y, no texto largo)
5. Limitar a datos verificables (no opiniones)
