# Streaming (Netflix, HBO, Prime, Disney+) — Knowledge Base

## Tipo de integración
- **NO son APIs públicas**: Netflix/HBO/Prime NO tienen API pública para contenido
- **Método MIIA**: Gemini google_search para recomendaciones
- **Módulo MIIA**: `integrations/adapters/streaming_integration.js`

## REGLA DE ORO
MIIA NO puede controlar la reproducción ni acceder al catálogo directamente. Solo recomienda basándose en gustos del owner.

## Datos en Firestore

| Campo | Qué es | Dónde |
|---|---|---|
| `services` | Plataformas que tiene: ["netflix", "prime"] | `users/{uid}/miia_interests/streaming` |
| `genres` | Géneros favoritos: ["sci-fi", "thriller"] | `users/{uid}/miia_interests/streaming` |

## Errores comunes

### 1. Contenido no disponible en el país
- Netflix tiene catálogo diferente por país
- "Mirá Breaking Bad en Netflix" → puede no estar en Colombia
- **Fix**: Incluir país del owner en la búsqueda de Gemini

### 2. Gemini recomienda contenido inexistente
- Puede inventar títulos o mezclar plataformas
- **Fix**: Prompt debe decir "Solo recomienda contenido que exista y que esté en {plataformas del owner}"

### 3. Links directos
- Netflix: `https://www.netflix.com/search?q={titulo}` → abre búsqueda
- Prime: `https://www.primevideo.com/search?phrase={titulo}`
- Disney+: `https://www.disneyplus.com/search/{titulo}`
- HBO: `https://play.hbomax.com/search?query={titulo}`

## Privacidad
- Los gustos de streaming son dato personal
- NUNCA compartir con leads lo que el owner ve
- "Tu jefe está viendo Game of Thrones" → INACEPTABLE
