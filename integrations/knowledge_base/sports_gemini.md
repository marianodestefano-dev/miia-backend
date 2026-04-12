# Deportes via Gemini google_search — Knowledge Base

## Aplica a: Fútbol, Tenis, NBA, UFC, Rugby, Boxeo, Golf, Ciclismo
(F1 y MLB tienen APIs directas — ver openf1.md y mlb_stats.md)

## Método
Gemini con `google_search` tool para obtener datos en vivo de partidos/eventos.

## Módulos MIIA
- `sports/adapters/futbol_adapter.js`
- `sports/adapters/tenis_adapter.js`
- `sports/adapters/nba_adapter.js`
- `sports/adapters/ufc_adapter.js`
- `sports/adapters/rugby_adapter.js`
- `sports/adapters/boxeo_adapter.js`
- `sports/adapters/golf_adapter.js`
- `sports/adapters/ciclismo_adapter.js`

## REGLA DE ORO
Gemini puede INVENTAR resultados deportivos. SIEMPRE verificar que la respuesta incluya fuente verificable. Si no hay datos concretos → NO reportar score.

## Errores comunes POR DEPORTE

### Fútbol
- **Ambigüedad de equipos**: "Nacional" → Colombia? Uruguay? Paraguay?
- **Fix**: Incluir liga: "Atlético Nacional Liga BetPlay Colombia"
- **Horarios**: Partidos nocturnos en Europa = madrugada en América
- **IDs**: No hay IDs estándar. Usar `nombreEquipo + liga + fecha` como identificador

### Tenis
- **Múltiples torneos simultáneos**: Puede confundir ATP vs WTA
- **Fix**: Incluir nombre del torneo: "Roland Garros 2026 Djokovic"
- **Sets**: Reportar formato correcto (3 sets en Grand Slam mujeres, 5 en hombres)

### NBA
- **Conferencia**: Puede confundir equipos del Este vs Oeste
- **Overtime**: Puede no reportar OT correctamente
- **Fix**: Query incluir "NBA regular season/playoffs 2026"

### UFC/MMA
- **Eventos infrecuentes**: ~2 por mes, fácil de confundir fecha
- **Métodos de victoria**: KO, TKO, Submission, Decision → Gemini puede confundir
- **Fix**: Buscar "UFC [número de evento] resultados"

### Rugby
- **Múltiples formatos**: Rugby Union (15) vs Rugby League (13) vs 7s
- **Fix**: Especificar formato: "Super Rugby Pacific" o "Six Nations"
- **Scoring**: Try=5, Conversion=2, Penalty=3, Drop goal=3

### Boxeo
- **Eventos infrecuentes**: ~4-5 peleas grandes por año
- **Múltiples organizaciones**: WBC, WBA, IBF, WBO
- **Fix**: Incluir nombre de peleadores + organización

### Golf
- **Torneos de 4 días**: Thu-Sun, scores cambian cada hoyo
- **Leaderboard largo**: Top 70+ jugadores
- **Fix**: Solo reportar movimientos en top 10 o del jugador del contacto

### Ciclismo
- **Etapas diarias**: Tour, Giro, Vuelta → 21 etapas cada uno
- **GC vs etapa**: Clasificación general ≠ ganador de etapa
- **Fix**: Especificar "clasificación general" o "ganador etapa X"

## Rate Limits compartidos
Todos estos deportes comparten el rate limit de Gemini google_search:
- Free: 15 RPM
- Durante día con múltiples eventos simultáneos → priorizar por interés del contacto
- Cola de prioridad: fútbol > F1 > los demás (según preferencias de Mariano)

## Polling intervals recomendados

| Deporte | En vivo | Schedule check |
|---|---|---|
| Fútbol | 60s | Cada 30min |
| Tenis | 90s | Cada 30min |
| NBA | 60s | Cada 30min |
| UFC | 120s | Cada 6h |
| Rugby | 60s | Cada 30min |
| Boxeo | 120s | Cada 6h |
| Golf | 300s | Cada 6h |
| Ciclismo | 300s | Cada 6h |
