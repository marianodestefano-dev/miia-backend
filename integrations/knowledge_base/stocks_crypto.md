# Stocks & Crypto — Knowledge Base

## API
- **Servicio**: Gemini google_search (datos en tiempo real)
- **Auth**: API Key de Gemini
- **Alternativa futura**: Alpha Vantage (stocks), CoinGecko (crypto)
- **Módulo MIIA**: `integrations/adapters/stocks_integration.js`

## REGLA DE ORO
Los símbolos de acciones/crypto son IDs estándar pero pueden ser ambiguos:
- "AAPL" → Apple (claro)
- "META" → Meta/Facebook (claro)
- "BTC" → Bitcoin (claro)
- Pero "SOL" → Solana? O el Sol (moneda peruana)?
SIEMPRE validar con el owner qué activo sigue.

## Datos en Firestore

| Campo | Qué es | Dónde |
|---|---|---|
| `symbols` | Lista de tickers: ["AAPL", "BTC-USD"] | `users/{uid}/miia_interests/stocks` |
| `alertThreshold` | % de cambio para alertar (default: 5%) | `users/{uid}/miia_interests/stocks` |

## Errores comunes

### 1. Datos con delay
- **Acciones**: Datos gratis tienen delay de 15-20 minutos
- **Crypto**: Datos gratis suelen ser real-time o delay de 1 min
- **Regla**: SIEMPRE mencionar "datos pueden tener delay de X minutos" en alertas

### 2. Mercado cerrado
- Bolsa USA: L-V 9:30-16:00 EST
- Crypto: 24/7
- No alertar de acciones en fin de semana (precio no cambia)
- SÍ alertar de crypto siempre

### 3. Gemini puede inventar precios
- Si no encuentra datos actuales, puede "adivinar" precios
- **Fix**: El prompt DEBE decir "SI NO ENCONTRÁS EL PRECIO EXACTO Y ACTUAL, decí que no pudiste obtenerlo"

### 4. Formato de números por país
- Argentina: $1.234,56 (punto miles, coma decimales)
- USA: $1,234.56 (coma miles, punto decimales)
- Colombia: $1.234,56 (igual que Argentina)
- MIIA debe formatear según el país del owner

## Rate Limits (APIs directas — futuro)
- **Alpha Vantage free**: 5 requests/min, 500/día
- **Alpha Vantage premium**: $50/mes, ilimitado
- **CoinGecko free**: 30 requests/min, sin límite diario
- **CoinGecko Pro**: $130/mes, 500 req/min
- **Gemini google_search**: 15 RPM free → suficiente para MIIA

## Privacidad
- Las inversiones del owner son datos MUY sensibles
- NUNCA compartir con leads/contactos qué activos sigue
- NUNCA mencionar montos o patrimonio en conversaciones con terceros
