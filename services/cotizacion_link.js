// ─────────────────────────────────────────────────────────────────────
// COTIZACIÓN — LINK INTERACTIVO (single live path)
// ─────────────────────────────────────────────────────────────────────
// Sucesor de cotizacion_generator.js (1033 líneas zombi con puppeteer+PDF).
// Motivo del retiro: C-148 desactivó el PDF. C-342 SEC-B.5 (firmada por Wi)
// autorizó eliminación del archivo zombi y consolidación del único camino
// vivo (link interactivo) en este módulo.
//
// Backup pre-eliminación: .claude/legacy/backups/cotizacion_generator_pre_B5.js
// Docu legacy:            .claude/legacy/PDF_COTIZACION_LEGACY_README.md
//
// Exports vivos:
//   - PRECIOS                 → matriz de precios por moneda (prompt auto)
//   - generarLinkCotizacion() → genera URL de propuesta web interactiva
//
// Callers actuales (C-342):
//   - server.js:157                 → require('./services/cotizacion_link')
//   - whatsapp/tenant_message_handler.js:3075 → require('../services/cotizacion_link')
//   - core/prompt_registry.js:367   → require('../services/cotizacion_link') para PRECIOS
//
// NO agregar aquí: buildHTML, generarPDF, enviarCotizacionWA. El PDF
// está retirado. Si hay que volver a emitir PDFs, abrir carta nueva.
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// MATRIZ DE PRECIOS (consumida por core/prompt_registry.js para auto-prompt)
//
// ⚠️ FUENTE DE VERDAD DRIFT:
// Los precios de aquí deben coincidir con miia-frontend/p/cotizacion.html
// (var BOLSAS y PR). Test anti-drift: __tests__/pricing_consistency.test.js
// (C-342 B.6).
// ─────────────────────────────────────────────────────────────────────
const PRECIOS = {
  CLP: {
    planes: { S: 35000, M: 55000, L: 85000 },
    adic1: { S: 15000, M: 16000, L: 18000 },
    adic2: { S: 12500, M: 13500, L: 15500 },
    adic3: { S:  9500, M: 10500, L: 12000 },
    bolsas: {
      WA:      { S: 17780,  M: 38894,  L:  83671, XL: 197556 },
      factura: { S: 10000,  M: 13000,  L:  20000, XL:  30000 },
      firma:   { S: 20833,  M: 39063,  L:  69444, XL: 164474 }
    },
    rangos: {
      WA:      { S: 150, M: 350, L:  800, XL: 2000 },
      factura: { S:  50, M: 200, L:  500, XL: 1000 },
      firma:   { S:  50, M: 200, L:  500, XL: 1000 }
    }
  },
  COP: {
    planes: { S: 125000, M: 150000, L: 225000 },
    adic1: { S: 35000, M: 40000, L: 55000 },
    adic2: { S: 35000, M: 40000, L: 55000 },
    adic3: { S: 35000, M: 40000, L: 55000 },
    bolsas: {
      WA:      { S:  11000, M:  23000, L:  75000, XL: 120000 },
      factura: { S:  32000, M:  50000, L:  88000, XL: 165000 },
      firma:   { S:  15000, M:  30000, L:  70000, XL: 140000 }
    },
    rangos: {
      WA:      { S: 150, M: 350, L:  800, XL: 2000 },
      factura: { S:  50, M: 200, L:  500, XL: 1000 },
      firma:   { S:  50, M: 200, L:  500, XL: 1000 }
    }
  },
  MXN: {
    planes: { S: 842.80, M: 1180, L: 1297 },
    adic1: { S: 250, M: 300, L: 450 },
    adic2: { S: 250, M: 300, L: 450 },
    adic3: { S: 250, M: 300, L: 450 },
    bolsas: {
      WA:      { S:  210, M:  360, L:  680, XL: 1300 },
      factura: { S:  160, M:  270, L:  440, XL:  500 },
      firma:   { S:  450, M:  790, L: 1400, XL: 3300 }
    },
    rangos: {
      WA:      { S: 150, M: 350, L: 800, XL: 2000 },
      factura: { S:  50, M: 100, L: 200, XL:  500 },
      firma:   { S:  50, M: 100, L: 200, XL:  500 }
    }
  },
  USD: {
    planes: { S: 45, M: 65, L: 85 },
    adic1: { S: 12, M: 13, L: 14 },
    adic2: { S: 12, M: 13, L: 14 },
    adic3: { S: 12, M: 13, L: 14 },
    bolsas: {
      WA:      { S: 15, M:  35, L:  70, XL: 170 },
      factura: { S: 10, M:  17, L:  35, XL:  60 },
      firma:   { S: 25, M:  40, L:  70, XL: 170 }
    },
    rangos: {
      WA:      { S: 150, M: 350, L: 800, XL: 2000 },
      factura: { S:  50, M: 100, L: 200, XL:  500 },
      firma:   { S:  50, M: 100, L: 200, XL:  500 }
    }
  },
  // España (EUR) — ANUALES (×12 meses). Solo modalidad anual.
  EUR: {
    planes: { S: 840, M: 1200, L: 1440 },
    adic1: { S: 120, M: 192, L: 240 },
    adic2: { S: 120, M: 192, L: 240 },
    adic3: { S: 120, M: 192, L: 240 },
    bolsas: {
      WA:      { S: 180, M:  396, L:  864, XL: 2040 },
      firma:   { S: 300, M:  540, L:  960, XL: 2400 }
      // factura: ES no tiene facturador (C-342 B.3 — aligned con cotizacion.html MODS.factura.countries)
    },
    rangos: {
      WA:      { S: 150, M: 350, L: 800, XL: 2000 },
      firma:   { S:  50, M: 100, L: 200, XL:  500 }
    }
  }
};

// ─────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────
function getBolsaTier(key) {
  const map = { 'S': 0, 'M': 1, 'L': 2, 'XL': 3 };
  return (key && map[key] !== undefined) ? map[key] : -1;
}

/**
 * Normaliza nombre de país (del LLM) a ISO-2 para el frontend.
 * C-342 B.5: extendido a 17 países (scope Opción B completa).
 * Países sin mapping explícito caen a 'INTL' → frontend usa pricing OP (USD).
 */
function mapPaisToCountry(pais) {
  if (!pais) return 'INTL';
  const key = String(pais).toUpperCase().replace(/\s+/g, '_');
  const map = {
    // Nativos
    COLOMBIA: 'CO', CHILE: 'CL', MEXICO: 'MX', MÉXICO: 'MX',
    ESPAÑA: 'ES', ESPANA: 'ES',
    // OP — pricing USD normalizado
    ARGENTINA: 'AR',
    REPUBLICA_DOMINICANA: 'DO', REPÚBLICA_DOMINICANA: 'DO',
    PERU: 'PE', PERÚ: 'PE',
    ECUADOR: 'EC',
    USA: 'US', EEUU: 'US', ESTADOS_UNIDOS: 'US',
    URUGUAY: 'UY',
    PARAGUAY: 'PY',
    BOLIVIA: 'BO',
    VENEZUELA: 'VE',
    GUATEMALA: 'GT',
    COSTA_RICA: 'CR',
    PANAMA: 'PA', PANAMÁ: 'PA',
    BRASIL: 'BR', BRAZIL: 'BR',
    INTERNACIONAL: 'INTL'
  };
  return map[key] || 'INTL';
}

// ─────────────────────────────────────────────────────────────────────
// GENERAR LINK DE COTIZACIÓN INTERACTIVA (propuesta web)
// ─────────────────────────────────────────────────────────────────────
/**
 * Genera un link de cotización interactiva vía el endpoint /api/cotizacion/generate.
 * Retorna la URL o null si falla (silencioso — no romper el flujo de WhatsApp).
 *
 * @param {string} tenantUid - UID del tenant
 * @param {{ nombre?: string, phone: string }} lead - Datos del lead
 * @param {object} params - Parámetros de la cotización (del tag GENERAR_COTIZACION)
 * @returns {Promise<string|null>} URL de la propuesta o null
 */
async function generarLinkCotizacion(tenantUid, lead, params) {
  try {
    const internalToken = process.env.MIIA_INTERNAL_TOKEN;
    if (!internalToken) {
      console.warn('[COTIZACION] ⚠️ MIIA_INTERNAL_TOKEN no configurado — link no generado');
      return null;
    }

    function sanitizeName(n) {
      if (!n) return null;
      if (/^\+?[\d\s\-]{7,}$/.test(String(n).trim())) return null;
      return String(n).trim();
    }

    const body = {
      tenant_id:  tenantUid,
      lead_name:  sanitizeName(lead.nombre),
      lead_phone: lead.phone,
      params: {
        plan:      (params.plan || 'esencial').toLowerCase(),
        users:     params.usuariosPagos || params.usuarios || 1,
        modalidad: params.modalidad || 'mensual',
        country:   mapPaisToCountry(params.pais),
        currency:  params.moneda || 'USD',
        modulos: {
          wa:      { on: !!params.incluirWA,       tier: getBolsaTier(params.bolsaWA) },
          firma:   { on: !!params.incluirFirma,    tier: getBolsaTier(params.bolsaFirma) },
          factura: { on: !!params.incluirFactura,  tier: getBolsaTier(params.bolsaFactura) },
        },
        citasMes:        params.citasMes || 70,
        descuentoCustom: params.descuentoCustom || null,
        usuariosBonus:   params.usuariosBonus || 0,
        // C-350: lockUsers = true → owner cotizó desde self-chat con bonus fijo.
        // Frontend oculta botones +/- y el lead NO puede modificar la cantidad.
        // Uso: "hacé cotización para Argentina 5 usuarios + 3 gratis" (comando owner).
        lockUsers:       !!params.lockUsers,
        // Segmentación por tipo de negocio: si Gemini detecta estética/derma,
        // emite lockPlan="titanium" → HTML muestra SOLO esa card (oculta Esencial/Pro).
        lockPlan:        (params.lockPlan && ['esencial','pro','titanium'].includes(String(params.lockPlan).toLowerCase()))
                           ? String(params.lockPlan).toLowerCase()
                           : null,
      },
    };

    const railwayUrl = process.env.RAILWAY_INTERNAL_URL || `http://localhost:${process.env.PORT || 8080}`;
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${railwayUrl}/api/cotizacion/generate`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${internalToken}`,
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await res.json();
    if (data.url) {
      console.log(`[COTIZACION] ✅ Link generado: ${data.url} (lead: ${lead.nombre || lead.phone})`);
      return data.url;
    }

    console.warn(`[COTIZACION] ⚠️ generate respondió sin URL: ${JSON.stringify(data)}`);
    return null;
  } catch (e) {
    console.error(`[COTIZACION] ❌ generarLinkCotizacion: ${e.message}`);
    return null; // silencioso — no romper el flujo de WhatsApp
  }
}

// ─────────────────────────────────────────────────────────────────────
module.exports = { PRECIOS, generarLinkCotizacion, mapPaisToCountry, getBolsaTier };
