# BAILEYS SESSION FORTRESS v2.0 — Referencia rápida

## Concepto central
WhatsApp Web dura semanas porque separa:
- **Device Identity** (noiseKey, signedIdentityKey, registrationId) → SAGRADA, nunca se borra
- **Session Keys** (ratchets Signal por conversación) → VOLÁTILES, se pueden purgar

## Archivos
- `baileys_session_store.js` — Fortress v2.0 (7 capas de protección)
- `tenant_manager.js` — Smart recovery (4 niveles de escalación)

## 7 Capas de protección
1. **Identity/Session separation** — identity NUNCA se borra en cleanup
2. **Identity backup ring** — últimas 3 versiones en Firestore
3. **Creds write guard** — bloquea saves durante errores crypto
4. **Atomic versioning** — version counter + hash por cada save
5. **Health tracking** — status persistente (healthy/degraded/corrupted)
6. **Session key purge** — borra keys volátiles sin tocar identity
7. **Identity restoration** — rollback a último backup conocido

## Smart Recovery (tenant_manager.js)
| Nivel | Intentos | Acción |
|-------|----------|--------|
| 1 | 1-3 | Purgar session keys → reconectar (Signal renegocia) |
| 2 | 4-7 | Restaurar identity desde backup + purgar keys |
| 3 | 8-30 | Cold restart con backoff exponencial (hasta 2 min) |
| 4 | 31+ | **Recién ahora** pide QR (no debería llegar nunca) |

## Deduplicación de mensajes
- `isDuplicate(msgId)` — Map en memoria, TTL 10 min
- Se limpia si server reinicia (Map vacío = mensajes frescos)
- IDs únicos por WhatsApp → nunca bloquea mensajes legítimos

## Firestore
```
baileys_sessions/{clientId}/
├── data/creds              ← Creds actuales
├── data/identity_backup_1  ← Backup más reciente
├── data/identity_backup_2
├── data/identity_backup_3  ← Backup más antiguo
├── data/creds_meta         ← Version, hash, timestamp
├── data/health             ← Status tracking
└── keys/{keyId}            ← Session keys (VOLÁTILES)
```
