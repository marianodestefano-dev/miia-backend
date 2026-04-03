# PLAN BLOQUE D: Limpieza Técnica

**Fecha**: 2026-04-03
**Standard**: Google + Amazon + NASA
**Estimación**: 2-3 horas
**Dependencias**: Ninguna (totalmente independiente)

---

## CONCEPTO

Eliminar código muerto, archivos obsoletos, y corregir referencias rotas.
Cada cambio es pequeño y aislado — bajo riesgo.

---

## D1: P5 — Limpiar código muerto de whatsapp-web.js

### Estado actual
- `processMediaMessage` (server.js:2276-2292) tiene un else branch que NUNCA se ejecuta
- Ya convertido a FAIL LOUDLY (throws error) — esto es correcto
- Pero el comentario menciona "whatsapp-web.js deprecated" — limpiar nomenclatura

### Cambio
- Ya está bien como está (throw en path imposible = correcto por NASA standard)
- Solo verificar que no hay otras referencias a whatsapp-web.js API en código activo

### Verificación necesaria
```bash
grep -rn "whatsapp-web" server.js tenant_manager.js prompt_builder.js message_logic.js
```

### Estimación: 15 min

---

## D2: P6 — cerebro_absoluto.js usa getChats() de whatsapp-web.js

### Estado actual
- `cerebro_absoluto.js` (313 líneas) usa API de whatsapp-web.js
- `server.js:38` hace `require('./cerebro_absoluto')`
- La función de "minado nocturno" no funciona porque getChats() no existe en Baileys

### Opciones
1. **Refactorizar cerebro_absoluto para Baileys**: Reemplazar getChats() por equivalente Baileys
2. **Desactivar minado nocturno**: Comentar/flag hasta que se migre
3. **Eliminar y reescribir en Bloque G** (Sistema Inteligencia): El minado es parte del Motor de Patrones

### Recomendación: Opción 3
cerebro_absoluto.js hace algo que el Bloque G (Sistema Inteligencia) va a rehacer mejor.
Por ahora: verificar que el require no causa errores al startup, y documentar que está deprecated.

### Cambio mínimo
```javascript
// server.js — ya cargado pero verificar que no crashea
const cerebroAbsoluto = require('./cerebro_absoluto');
// Si alguna función se llama y falla silenciosamente → agregar try/catch + log
```

### Estimación: 30 min

---

## D3: P7 — Archivos obsoletos

### Análisis de dependencias (VERIFICADO)

| Archivo | ¿Requirido por alguien? | Veredicto |
|---------|------------------------|-----------|
| `firestore_session_store.js` (200 líneas) | ❌ No — nadie lo importa | ELIMINAR |
| `messageProcessor.js` (299 líneas) | ❌ No — nadie lo importa | ELIMINAR |
| `cerebro_medilink_backup.js` (3300 líneas) | ❌ Solo se importa a sí mismo + cerebro_absoluto | LEGACY — mover a backups/ |
| `baileys_session_store.js` (166 líneas) | ✅ tenant_manager.js:21 + server.js:3527 | NO TOCAR |
| `cerebro_absoluto.js` (313 líneas) | ✅ server.js:38 | NO TOCAR (ver D2) |

### Cambios
1. `git rm firestore_session_store.js`
2. `git rm messageProcessor.js`
3. `git mv cerebro_medilink_backup.js backups/cerebro_medilink_backup.js`
4. Verificar que `__tests__/endpoints.test.js` no importa ninguno de estos

### Estimación: 15 min

---

## D4: P4 — Exportar setTenantTrainingData en tenant_manager

### Estado actual
- `setTenantTrainingData` existe en tenant_manager.js (línea ~630)
- NO está en `module.exports` (líneas ~650-661)
- Training data no persiste correctamente en auto-reconexión

### Cambio
```javascript
// tenant_manager.js — module.exports
module.exports = {
  // ... existing exports ...
  setTenantTrainingData,  // ← AGREGAR
};
```

### Verificar que server.js ya intenta importarla:
```bash
grep "setTenantTrainingData" server.js
```

### Estimación: 10 min

---

## D5: P3 — Endpoint documentos roto en admin-dashboard

### Estado actual
- Frontend llama: `/api/tenant/:uid/documents/upload`
- Backend tiene: `/api/documents/upload` (sin tenant prefix)
- Tab "Documentos" en admin no funciona

### Opciones
1. Cambiar frontend a `/api/documents/upload`
2. Agregar alias en backend: `/api/tenant/:uid/documents/upload` → misma lógica
3. Migrar todo a tenant-scoped (correcto a largo plazo)

### Recomendación: Opción 2 (alias) ahora, Opción 3 cuando se haga Bloque F (multi-negocio)

### Cambio
```javascript
// server.js — agregar alias
app.post('/api/tenant/:uid/documents/upload', authenticateUser, (req, res) => {
  // Redirect to existing handler
  req.url = '/api/documents/upload';
  // ... o simplemente duplicar la lógica
});
```

### Estimación: 30 min

---

## Orden de Implementación

| Sub | Qué | Riesgo | Estimación |
|-----|-----|--------|-----------|
| D4 | Export setTenantTrainingData | Bajo | 10 min |
| D3 | Eliminar archivos obsoletos | Bajo | 15 min |
| D1 | Verificar código muerto whatsapp-web.js | Bajo | 15 min |
| D5 | Fix endpoint documentos | Bajo | 30 min |
| D2 | Documentar cerebro_absoluto deprecated | Bajo | 30 min |

**Total**: ~1.5-2 horas

---

## Archivos Afectados

| Archivo | Cambio |
|---------|--------|
| `tenant_manager.js` | Agregar setTenantTrainingData a exports |
| `server.js` | Alias endpoint documentos |
| `firestore_session_store.js` | ELIMINAR |
| `messageProcessor.js` | ELIMINAR |
| `cerebro_medilink_backup.js` | Mover a backups/ |

---

*Documento generado — Sesión 9, 2026-04-03*
