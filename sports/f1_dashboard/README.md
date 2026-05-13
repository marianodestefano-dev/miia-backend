# MIIAF1 — F1 Dashboard add-on

Add-on $3 USD/mes para MIIA. Dashboard live de F1 con scraping propio,
fantasy league, comandos WhatsApp y notificaciones por piloto adoptado.

**Spec**: `.claude/IDEAS_PENDIENTES.md` IDEA #052 (firmada 2026-04-24 + arranque 2026-05-01).
**Audit completo Q2 MVP**: `JUEGA-MIIA/.juega_miia/operativo/MEMO_AUDIT_MIIAF1.md` (2026-05-12).

## Arquitectura

```
miia-backend/
├── sports/f1_dashboard/        ← código F1 (este directorio)
│   ├── f1_schema.js            ← Firestore schema + paths
│   ├── f1_seed_2025.js         ← seed 24 GPs + 20 drivers
│   ├── results_scraper.js      ← scraping formula1.com (rate limit 5s)
│   ├── live_scraper.js         ← live timing (formula1.com + livetiming.formula1.com)
│   ├── live_cache.js           ← Redis + memory fallback TTL 30s
│   ├── f1_notifications.js     ← WA post-carrera por piloto adoptado
│   ├── f1_live_notifier.js     ← WA durante carrera (rate limit 5 vueltas)
│   ├── f1_cron.js              ← cron post-GP
│   ├── f1_history.js           ← historial GPs + driver season history
│   ├── f1_fantasy.js           ← puntos fantasy + leaderboard cross-tenant
│   ├── f1_paywall.js           ← hasF1Addon + activate + middleware
│   ├── f1_telemetry.js         ← OpenF1 telemetry adapter
│   ├── session_detector.js     ← detecta FP1/FP2/FP3/Q/Race
│   ├── circuit_maps.js         ← SVG 24 circuitos
│   ├── circuit_overlay.js      ← overlay posiciones drivers en SVG
│   ├── f1_service.js           ← servicio Railway separado (puerto 3001)
│   └── railway.f1.json         ← config Railway NIXPACKS
├── routes/
│   ├── f1.js                   ← API REST /api/f1/* (calendar, results, etc.)
│   └── f1_billing.js           ← checkout + webhook addon
├── core/f1_adapter.js          ← adapter genérico F1
└── lib/monetization/           ← NUEVO post B.3 (firma Mariano 2026-05-12)
    ├── payment-provider.js     ← factory + selector country
    └── providers/
        ├── mercadopago.js      ← SDK oficial mercadopago
        └── paypal.js           ← SDK oficial @paypal/checkout-server-sdk
```

## Env vars requeridas (Railway prod)

### Críticas — sin estas el servicio NO arranca

```bash
# Firestore
GOOGLE_APPLICATION_CREDENTIALS=<base64 service account>
FIRESTORE_PROJECT_ID=miia-app-8cbd0

# F1 Service (Railway separate service)
F1_SERVICE_PORT=3001          # default si no se setea
F1_SEASON=2026                # default si no se setea

# Cache live (TTL 30s)
REDIS_URL=redis://default:<pass>@<host>:<port>   # Upstash o Railway Redis
```

### Pagos — F1.30 firma Mariano 2026-05-12

```bash
# MercadoPago (LATAM core: AR/BR/CL/CO/MX/PE/UY)
MP_ACCESS_TOKEN=APP-USR-<token-real>             # YA EN USO (server.js legacy)
MP_WEBHOOK_SECRET=<random-64-chars>              # NUEVO — necesario para verifyWebhook HMAC
MP_SANDBOX=false                                  # 'true' en dev/sandbox, 'false' prod

# PayPal (resto del mundo + LATAM fallback)
PAYPAL_CLIENT_ID=<client-id-real>                # YA EN USO (server.js legacy)
PAYPAL_CLIENT_SECRET=<secret-real>               # YA EN USO
PAYPAL_WEBHOOK_ID=<webhook-id-from-paypal-dash>  # NUEVO — necesario para verifyWebhook RSA
PAYPAL_MODE=production                            # 'sandbox' en dev, 'production' prod

# General webhook
API_URL=https://miia-backend.railway.app          # para webhook callbacks
WEBHOOK_SECRET=<random-64-chars>                  # genérico (existe pre-B.3)
```

### Legacy (NO tocar)

```bash
PADDLE_WEBHOOK_SECRET=...     # legacy, Mariano firmó "Stripe FUERA" 2026-04-30 (incluye Paddle)
STRIPE_WEBHOOK_SECRET=...     # legacy, ignorar
```

## Deploy checklist Railway B.4

**Pre-requisito:** Mariano debe ejecutar el deploy. TEC no tiene CLI Railway (Vi
confirmó en `[RESPUESTA-VI-MIIAF1]` Q6 2026-05-12).

1. **Crear nuevo proyecto Railway** "miia-f1-service" (separado del backend principal).

2. **Conectar repo GitHub**: `marianodestefano-dev/miia-backend` branch `main`.

3. **Config path**: settear `RAILWAY_CONFIG_FILE=sports/f1_dashboard/railway.f1.json`
   o copiar contenido a `railway.json` raíz.

4. **Variables env** (settear en Railway dashboard, NO commitear):
   - Todas las críticas listadas arriba (Firestore + F1 Service + Redis).
   - Todas las de pagos listadas arriba.
   - Generar nuevos `MP_WEBHOOK_SECRET` y `PAYPAL_WEBHOOK_ID` desde dashboards
     respectivos (no son los mismos que MP_ACCESS_TOKEN/PAYPAL_CLIENT_*).

5. **MercadoPago — configurar webhook URL en MP dashboard**:
   - URL: `https://miia-f1-service.railway.app/api/f1/billing/webhook?country=AR`
   - Events: `payment.created`, `payment.updated`
   - Copiar el "Secret signature" generado por MP → setear como `MP_WEBHOOK_SECRET`
     en Railway.

6. **PayPal — configurar webhook URL en PayPal Developer dashboard**:
   - URL: `https://miia-f1-service.railway.app/api/f1/billing/webhook`
   - Events: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`
   - Copiar el `Webhook ID` (formato `WH-xxx`) → setear como `PAYPAL_WEBHOOK_ID`.

7. **Deploy**: `Railway dashboard → Deploy → New Deployment`.

8. **Smoke test** post-deploy:
   ```bash
   curl https://miia-f1-service.railway.app/health
   # → { "status": "ok", "scraper": {...}, "ts": "..." }

   curl https://miia-f1-service.railway.app/positions
   # → { "positions": [], "raceStatus": null, "ts": "..." }  (vacío hasta primera carrera)
   ```

9. **Probar checkout** (sandbox primero, luego producción):
   ```bash
   curl -X POST https://miia-f1-service.railway.app/api/f1/billing/checkout \
     -H "Content-Type: application/json" \
     -d '{"uid":"test-uid","country":"AR"}'
   # Esperado: { "checkoutUrl": "https://mercadopago.com/...", "provider": "mercadopago", ... }
   ```

## Endpoints API

| Method | Path | Descripción |
|---|---|---|
| GET | `/api/f1/calendar` | 24 GPs temporada |
| GET | `/api/f1/results/:gpId` | Resultados de un GP |
| GET | `/api/f1/standings/drivers` | Standings pilotos |
| GET | `/api/f1/standings/constructors` | Standings constructores |
| GET | `/api/f1/driver/:driverId` | Detalle piloto |
| POST | `/api/f1/adopt` | Adoptar piloto (requiere addon) |
| GET | `/api/f1/prefs` | Preferencias owner (piloto adoptado, notif) |
| POST | `/api/f1/prefs` | Update prefs |
| GET | `/api/f1/live/positions` | Live positions cache |
| GET | `/api/f1/fantasy/leaderboard` | Leaderboard cross-tenant (requiere addon) |
| POST | `/api/f1/billing/checkout` | Iniciar checkout $3/mes |
| POST | `/api/f1/billing/webhook` | Webhook MP+PayPal |

## Comandos WhatsApp (F1.23 + F1.26)

Owner en su self-chat con MIIA:

```
/f1 posiciones        → standings pilotos top 10
/f1 resultado         → último GP
/f1 siguiente         → próximo GP countdown
/f1 mipiloto          → status piloto adoptado
/f1 adoptar <name>    → adoptar piloto
/f1 piloto <name>     → info piloto
/f1 circuito          → SVG del próximo circuito
```

## Fantasy League (F1.27)

Cross-tenant leaderboard global vía `collectionGroup('f1_prefs')` Firestore.
Mariano firmó P1 OPCIÓN A 2026-05-12: una sola liga global cumple Q2 MVP.
Ligas privadas multi-grupo NO se implementan en Q2 MVP (Mariano puede firmar
opción B en el futuro si quiere).

Puntuación por GP del piloto adoptado:
- Posición: 25/18/15/12/10/8/6/4/2/1 (1°-10°)
- Vuelta rápida: +2 (si top 10)
- Pole position: +3
- Bonus overtake: +5 (si arrancó P5+ y terminó top 3)
- DNF: 0

## Troubleshooting

### Scraper no actualiza posiciones live
1. Verificar `REDIS_URL` válido y conectividad: `redis-cli -u $REDIS_URL ping`.
2. Verificar logs `[F1-LIVE]` en Railway service logs.
3. Si circuit breaker activo: esperar 30s, reintenta automáticamente.

### Webhook MP no activa subscription
1. Verificar `MP_WEBHOOK_SECRET` matchea el secret generado en MP dashboard.
2. Verificar URL webhook configurada en MP dashboard apunta a Railway service.
3. Verificar logs `[F1-BILLING]` en Railway.
4. Si firma falla: probablemente desync de timestamp — verificar reloj sistema.

### Webhook PayPal devuelve 401
1. Verificar `PAYPAL_WEBHOOK_ID` matchea el ID generado en PayPal dashboard.
2. Verificar `PAYPAL_MODE` correcto (sandbox vs production).
3. Verificar headers `paypal-transmission-*` llegan al endpoint.

### Fantasy leaderboard vacío
1. Verificar que owners hayan adoptado piloto (`/api/f1/prefs` GET).
2. Verificar que haya GPs completados con resultados (collection `f1_data/{season}/gps`).
3. Verificar `f1_cron` corrió post-GP (Firestore `owners/{uid}/f1_fantasy/{gpId}`).

## Seguridad

- Webhooks: firma criptográfica obligatoria (HMAC SHA256 para MP, RSA-SHA256 para PayPal).
- Anti-SSRF: PayPal cert URL whitelist contra `api.paypal.com`, `api.sandbox.paypal.com`, `api.paypalobjects.com`.
- Anti-replay: validar `external_reference` único + timestamp dentro de ventana ±5min.
- Rate limit: `/checkout` 5 req/min/IP, `/webhook` ilimitado (firma valida).
- AbortController obligatorio en cualquier fetch externo (regla 6.18 CLAUDE.md).

## Vulnerabilities (npm audit)

15 vulns en transitive deps de `@paypal/checkout-server-sdk` (SDK no actualizado
hace años). Detalle:
- 1 critical (lodash <4.17.21 prototype pollution)
- 5 high
- 1 moderate
- 8 low

**Recomendación**: monitorear, no actualizar PayPal SDK sin verificar
breaking changes (puede romper checkout PROD). Si Mariano autoriza migración
futura → considerar `@paypal/server-sdk` v2 que es nueva implementación oficial
mantenida (no scope MIIAF1 Q2 MVP).

## Tests + cobertura

```bash
# Todos los tests F1 + monetization
npx jest --testPathPattern="f1_|monetization_"

# Con coverage
npx jest --testPathPattern="f1_|monetization_" \
  --coverage \
  --collectCoverageFrom="lib/monetization/**/*.js" \
  --collectCoverageFrom="sports/f1_dashboard/**/*.js" \
  --collectCoverageFrom="routes/f1*.js" \
  --collectCoverageFrom="core/f1_adapter.js"
```

Cobertura objetivo: **100% branches** (regla Mariano 2026-05-02).

## Firma de origen

- IDEA #052 firmada Mariano 2026-04-24 noche.
- Arranque Fase 1-5 firmado Mariano 2026-05-01 ("EMPIEZA A HACERLO!!!").
- Audit Q2 MVP TEC 2026-05-12: `JUEGA-MIIA/.juega_miia/operativo/MEMO_AUDIT_MIIAF1.md`.
- B.3 F1.30 pago real firmado Mariano + Vi 2026-05-12 — commit `f1f754c`.
- B.4 deploy Railway pendiente Mariano ejecutar con secrets.
- B.6 cov sweep + docs cerrado en este README + post-B.6 istanbul ignores.
