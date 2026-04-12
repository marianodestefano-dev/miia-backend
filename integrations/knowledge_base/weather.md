# Weather (Clima) — Knowledge Base

## API
- **Servicio**: Gemini google_search (NO OpenWeather directo)
- **Auth**: API Key de Gemini (ya configurada)
- **Docs**: Via Gemini AI con tool google_search
- **Módulo MIIA**: `integrations/adapters/weather_integration.js`

## REGLA DE ORO
Clima NO tiene IDs de recursos. El riesgo es **ciudad ambigua**: "Santiago" puede ser Chile, España, o Santiago de Cali. SIEMPRE incluir país en la búsqueda.

## Datos en Firestore

| Campo | Qué es | Dónde |
|---|---|---|
| `city` | Ciudad del owner | `users/{uid}/miia_interests/weather` |
| `country` | País (para desambiguar) | Derivado del teléfono del owner |
| `alertRain` | Alertar si llueve | `users/{uid}/miia_interests/weather` |
| `morningForecast` | Pronóstico matinal | `users/{uid}/miia_interests/weather` |

## Errores comunes

### 1. Ciudad ambigua
- "Bogotá" → OK (única en el mundo)
- "Santiago" → Chile? España? Cuba? Cali?
- "San José" → Costa Rica? California? España?
- **Fix**: SIEMPRE agregar país a la query: "clima en Santiago, Chile"

### 2. Gemini inventa datos de clima
- Si google_search no encuentra datos actuales, Gemini puede inventar temperatura
- **Fix**: El prompt debe decir "SI NO ENCONTRÁS DATOS REALES, decí que no pudiste obtener el clima"

### 3. Timezone del pronóstico
- "Mañana" depende del timezone del owner
- MIIA debe calcular la fecha local del owner, no UTC
- Un pronóstico para "mañana" a las 23:00 Colombia = "pasado mañana" en España

### 4. Unidades
- Colombia/Argentina: Celsius
- USA: Fahrenheit
- MIIA debe usar las unidades del país del owner automáticamente

## Rate Limits
- Gemini google_search: 15 RPM (free tier), 1,500 RPM (paid)
- MIIA hace ~2-4 requests de clima/día → muy dentro del límite

## Privacidad
- La ciudad del owner NO es dato ultra-sensible, pero no compartir con leads
- El clima es dato público, pero la ubicación del owner es privada
