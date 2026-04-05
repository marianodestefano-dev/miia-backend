# PLAN BLOQUE E: Rediseño Visual — QA + Pulido

**Fecha**: 2026-04-03
**Standard**: Google + Amazon + NASA
**Estimación**: 3-5 horas
**Dependencias**: Ninguna

---

## ESTADO ACTUAL — Ya Implementado

El rediseño dark/light mode está **~85% completo**:

| Componente | Estado |
|-----------|--------|
| `styles.css` — design tokens dark + light | ✅ Implementado (1170 líneas) |
| `data-theme="dark"` en todos los HTML | ✅ Todos los dashboards |
| Theme toggle button en sidebar | ✅ Todos los dashboards |
| localStorage persistence | ✅ `miia-theme` key |
| Firestore persistence | ✅ `themePreference` field |
| Early theme load (no flash) | ✅ Inline script en `<head>` |

---

## LO QUE FALTA — QA y Hardcoded Colors

### E1: Auditar colores hardcodeados en inline styles

Hay colores hex hardcodeados en inline `style=""` que NO responden al tema:

| Archivo | Hardcoded hex colors | Prioridad |
|---------|---------------------|-----------|
| admin-dashboard.html | 68 | Alta |
| owner-dashboard.html | 51 | Alta |
| agent-dashboard.html | 21 | Media |
| contacts.html | 8 | Baja |
| businesses.html | 8 | Baja |
| documents.html | 8 | Baja |

### Cambio
Para cada color hardcodeado en inline style:
1. Identificar qué token CSS le corresponde
2. Mover el estilo a una clase en `styles.css` usando la variable
3. Reemplazar `style="color: #ffffff"` por `class="text-bright"` (o similar)

### Nota: NO todos son bugs
Algunos hex hardcoded son correctos (ej: gradientes de marca, badges de status).
Solo migrar los que cambian entre dark/light (backgrounds, text colors, borders).

---

### E2: Verificar componentes en light mode

Verificar visualmente que TODOS estos componentes se ven bien en light mode:

| Componente | Archivo principal | Check |
|-----------|------------------|-------|
| Sidebar | todos los dashboards | ⬜ |
| Cards (stats, info) | owner/admin dashboard | ⬜ |
| Tablas | contacts, businesses | ⬜ |
| Modales (QR, editar, etc) | owner/admin dashboard | ⬜ |
| Inputs, selects, textareas | businesses (training) | ⬜ |
| Tabs | businesses (productos, etc) | ⬜ |
| Toast notifications | todos | ⬜ |
| Badges (online, offline, etc) | contacts | ⬜ |
| Charts/gráficos | owner dashboard | ⬜ |
| Code blocks / monospace | documents | ⬜ |

---

### E3: Responsive — Mobile sidebar

Verificar que el sidebar collapse funciona correctamente en mobile para ambos temas.
El sidebar en desktop es fijo; en mobile debería colapsar a hamburger o slide-out.

### Cambio (si no está implementado)
```css
@media (max-width: 768px) {
  .sidebar { transform: translateX(-100%); position: fixed; z-index: 1000; }
  .sidebar.open { transform: translateX(0); }
  .mobile-hamburger { display: block; }
}
```

---

### E4: `index.html` y `login.html` — NO TOCAR

Per decisión de Mariano: la página inicial y login NO se rediseñan.
Verificar que el cambio de tema en dashboards no afecta estas páginas.

---

## Orden de Implementación

| Sub | Qué | Estimación |
|-----|-----|-----------|
| E1 | Auditar + migrar hardcoded colors en admin-dashboard.html | 1.5h |
| E1 | Auditar + migrar hardcoded colors en owner-dashboard.html | 1.5h |
| E1 | Auditar agent-dashboard, contacts, businesses, documents | 1h |
| E2 | QA visual light mode (manual) | 0.5h |
| E3 | Responsive sidebar (si falta) | 0.5h |

**Total**: ~3-5 horas

---

## Archivos Afectados

| Archivo | Cambio |
|---------|--------|
| `styles.css` | Nuevas utility classes (text-bright, bg-surface, etc) si se necesitan |
| `owner-dashboard.html` | Reemplazar inline hex → CSS variables/classes |
| `admin-dashboard.html` | Reemplazar inline hex → CSS variables/classes |
| `agent-dashboard.html` | Reemplazar inline hex → CSS variables/classes |
| `contacts.html` | Minor fixes |
| `businesses.html` | Minor fixes |
| `documents.html` | Minor fixes |

---

*Documento generado — Sesión 9, 2026-04-03*
