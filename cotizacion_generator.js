'use strict';

/**
 * COTIZACION GENERATOR v1
 * Genera PDF de cotización Medilink y lo envía por WhatsApp.
 *
 * Uso:
 *   const cg = require('./cotizacion_generator');
 *   await cg.enviarCotizacionWA(whatsappClient, phone, params);
 *
 * params = {
 *   nombre, pais, moneda, usuarios, citasMes,
 *   incluirWA, bolsaWAForzada,
 *   incluirFirma, bolsaFirmaForzada,
 *   incluirFactura, bolsaFacturaForzada,
 *   descuento, vigencia, fecha
 * }
 */

const fs        = require('fs');
const path      = require('path');
let puppeteer;
try { puppeteer = require('puppeteer-core'); } catch(e) {
  console.warn('[COTIZACION] puppeteer-core no disponible — generación de PDF deshabilitada');
}

// ─────────────────────────────────────────────────────────────────────
// MATRICES DE PRECIOS (fuente: prompt_maestro.md)
// ─────────────────────────────────────────────────────────────────────

const PRECIOS = {

  CLP: {
    planes: { S: 35000, M: 55000, L: 85000 },
    // Adicionales escalonados por total de usuarios
    adic1: { S: 15000, M: 16000, L: 18000 },   // 2–5
    adic2: { S: 12500, M: 13500, L: 15500 },   // 6–10
    adic3: { S:  9500, M: 10500, L: 12000 },   // 11+
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
  }
};

// ─────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────

/** Formatea un número como moneda con separador de miles apropiado */
function fmt(value, moneda) {
  try {
    const n = Number(value);
    const sepMiles = (moneda === 'USD' || moneda === 'MXN') ? ',' : '.';
    if (moneda === 'MXN' && n % 1 !== 0) {
      const int = Math.floor(n);
      const dec = Math.round((n - int) * 100).toString().padStart(2, '0');
      return '$ ' + int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, sepMiles) + '.' + dec;
    }
    return '$ ' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, sepMiles);
  } catch(e) {
    console.error(`[FMT-ERROR] value=${value}, moneda=${moneda}, error=${e.message}`);
    throw e;
  }
}

/** Formatea número plano (para rangos de bolsas) */
function fmtNum(n) {
  try {
    const result = Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return result;
  } catch(e) {
    console.error(`[FMTNUM-ERROR] n=${n}, error=${e.message}`);
    throw e;
  }
}

/** Precio del usuario adicional según total de usuarios */
function getPrecioAdic(planKey, totalUsuarios, moneda) {
  const p = PRECIOS[moneda];
  if (totalUsuarios >= 11) return p.adic3[planKey];
  if (totalUsuarios >= 6)  return p.adic2[planKey];
  return p.adic1[planKey];
}

/** Selecciona el tier de bolsa más pequeño que cubre los envíos requeridos */
function selectTier(enviosRequeridos, rangos) {
  for (const tier of ['S', 'M', 'L', 'XL']) {
    if (enviosRequeridos <= rangos[tier]) return tier;
  }
  return 'XL';
}

/** Devuelve { tier, limiteEnvios, precio } para un módulo */
function getBolsa(modulo, envios, moneda, tierForzado) {
  const p = PRECIOS[moneda];
  const tier = tierForzado || selectTier(envios, p.rangos[modulo]);
  return { tier, limiteEnvios: p.rangos[modulo][tier], precio: p.bolsas[modulo][tier] };
}

// ─────────────────────────────────────────────────────────────────────
// CÁLCULO DE COTIZACIÓN
// ─────────────────────────────────────────────────────────────────────

function calcularCotizacion(params) {
  const {
    moneda          = 'CLP',
    usuarios        = 1,
    citasMes        = 100,
    incluirWA        = true,
    bolsaWA          = null,
    incluirFirma     = true,
    bolsaFirma       = null,
    incluirFactura   = true,
    bolsaFactura     = null,
    incluirRecetaAR  = false,
    descuento        = 30
  } = params;

  console.log(`[COTIZ-DEBUG] calcularCotizacion recibió: moneda=${moneda}, usuarios=${usuarios}, citasMes=${citasMes}, descuento=${descuento}`);
  if (!PRECIOS[moneda]) throw new Error(`Moneda no soportada: ${moneda}`);

  const nAdic = Math.max(0, usuarios - 1);
  const pct   = descuento / 100;
  const enviosWA       = citasMes * 2;
  const enviosFactFirm = citasMes;

  const planes  = {};
  const bolsas  = {};

  for (const [key, label] of [['S','esencial'],['M','pro'],['L','titanium']]) {
    const base     = PRECIOS[moneda].planes[key];
    const precAdic = getPrecioAdic(key, usuarios, moneda);
    const subtotal = base + precAdic * nAdic;
    const desc     = Math.round(subtotal * pct);
    planes[label]  = { base, precAdic, subtotal, descuento: desc, neto: subtotal - desc };
  }

  if (incluirWA)      bolsas.wa      = getBolsa('WA',      enviosWA,       moneda, bolsaWA);
  if (incluirFirma)   bolsas.firma   = getBolsa('firma',   enviosFactFirm, moneda, bolsaFirma);
  if (incluirFactura) bolsas.factura = getBolsa('factura', enviosFactFirm, moneda, bolsaFactura);

  const PRECIO_RECETA_AR = 3; // USD fijo
  const bolsasTotal = Object.values(bolsas).reduce((s, b) => s + b.precio, 0) + (incluirRecetaAR ? PRECIO_RECETA_AR : 0);
  for (const lbl of ['esencial','pro','titanium']) {
    planes[lbl].totalPromo    = planes[lbl].neto    + bolsasTotal;
    planes[lbl].totalSinPromo = planes[lbl].subtotal + bolsasTotal;
  }

  return { planes, bolsas, bolsasTotal, nAdic, enviosWA, enviosFactFirm, recetaAR: incluirRecetaAR ? PRECIO_RECETA_AR : 0 };
}

// ─────────────────────────────────────────────────────────────────────
// DATOS COMPARATIVA DE FUNCIONALIDADES
// ─────────────────────────────────────────────────────────────────────

const FEATURES = [
  { section: 'ATENCIÓN DE PACIENTES', items: [
    { name: 'Gestión de recursos',          S:'I', M:'I', L:'I' },
    { name: 'Agenda médica',                S:'I', M:'I', L:'I' },
    { name: 'Telemedicina',                 S:'I', M:'I', L:'I' },
    { name: 'Documentos personalizables',   S:'I', M:'I', L:'I' },
    { name: 'Recetas con Vademécum',        S:'I', M:'I', L:'I' },
    { name: 'Consentimientos informados',   S:'I', M:'I', L:'I' },
    { name: 'Ficha clínica electrónica',    S:'I', M:'I', L:'I' },
    { name: 'Agendamiento online',          S:'I', M:'I', L:'I' },
    { name: 'Ficha estética facial',        S:'A', M:'A', L:'I' },
    { name: 'Firma electrónica digital',    S:'A', M:'A', L:'A' },
    { name: 'Facturador electrónico',       S:'A', M:'A', L:'A' },
    { name: 'WhatsApp — Recordatorios',     S:'A', M:'A', L:'A' }
  ]},
  { section: 'GESTIÓN CLÍNICA', items: [
    { name: 'Inventario',                   S:'N', M:'I', L:'I' },
    { name: 'Pagos y Gastos',               S:'N', M:'I', L:'I' },
    { name: 'Remuneraciones',               S:'N', M:'I', L:'I' },
    { name: 'Laboratorios y exámenes',      S:'N', M:'N', L:'I' },
    { name: 'Convenios',                    S:'I', M:'I', L:'I' }
  ]},
  { section: 'CONTROL DE OPERACIONES', items: [
    { name: 'Tareas automáticas de citas',  S:'N', M:'N', L:'I' },
    { name: 'Reportes Excel',               S:'N', M:'I', L:'I' },
    { name: 'Flujo de caja automático',     S:'N', M:'I', L:'I' },
    { name: 'Gestión de sucursales',        S:'N', M:'I', L:'I' },
    { name: 'Integración con Siigo',        S:'N', M:'N', L:'I' },
    { name: 'Recaudación y Cajas',          S:'I', M:'I', L:'I' }
  ]},
  { section: 'FIDELIZACIÓN Y RETENCIÓN', items: [
    { name: 'Campañas de Agendamiento',     S:'N', M:'I', L:'I' },
    { name: 'Panel de desempeño',           S:'N', M:'I', L:'I' },
    { name: 'Email marketing y promociones',S:'N', M:'N', L:'I' },
    { name: 'Encuestas de satisfacción',    S:'N', M:'N', L:'I' },
    { name: 'Datáfono',                     S:'N', M:'N', L:'I' }
  ]}
];

function renderCell(v) {
  if (v === 'I') return '<td class="cell-yes"><span class="ck">&#10003;</span> Incluido</td>';
  if (v === 'N') return '<td class="cell-no"><span class="ds">&#8212;</span> No incluido</td>';
  return          '<td class="cell-add"><span class="pl">+</span> Adicional</td>';
}

// ─────────────────────────────────────────────────────────────────────
// LOGO BASE64
// ─────────────────────────────────────────────────────────────────────

function getLogoBase64() {
  try {
    const logoPath = path.join(__dirname, 'Medilink_logo.png');
    console.log(`[COTIZ-DEBUG] Buscando logo en: ${logoPath}`);
    const buf = fs.readFileSync(logoPath);
    console.log(`[COTIZ-DEBUG] Logo leído, buffer size: ${buf.length}`);
    const base64 = buf.toString('base64');
    console.log(`[COTIZ-DEBUG] Convertido a base64, size: ${base64.length}`);
    return 'data:image/png;base64,' + base64;
  } catch (e) {
    console.error(`[COTIZ-DEBUG] Error leyendo logo: ${e.message}`);
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────
// HTML TEMPLATE
// ─────────────────────────────────────────────────────────────────────

function buildHTML(params) {
  const {
    nombre          = 'Lead',
    pais            = 'CHILE',
    moneda          = 'CLP',
    usuarios        = 1,
    citasMes        = 100,
    incluirWA        = true,
    incluirFirma     = true,
    incluirFactura   = true,
    incluirRecetaAR  = false,
    descuento        = 30,
    vigencia         = 'Próximos 7 días — 3 cupos disponibles',
    fecha           = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })
  } = params;

  console.log(`[COTIZ-DEBUG] buildHTML iniciado para ${nombre}, moneda=${moneda}`);
  const logo  = getLogoBase64();
  console.log(`[COTIZ-DEBUG] Logo obtenido, llamando calcularCotizacion...`);
  const calc  = calcularCotizacion(params);
  console.log(`[COTIZ-DEBUG] calcularCotizacion completado`);
  console.log(`[COTIZ-DEBUG] calc.bolsas =`, calc.bolsas ? Object.keys(calc.bolsas) : 'undefined');
  const { planes, bolsas, nAdic, enviosWA, enviosFactFirm, recetaAR } = calc;
  const { esencial: es, pro, titanium: ti } = planes;
  const p     = PRECIOS[moneda];
  console.log(`[COTIZ-DEBUG] PRECIOS[${moneda}] =`, p ? 'OK' : 'UNDEFINED');
  console.log(`[COTIZ-DEBUG] Construyendo logoTag...`);

  const logoTag = logo
    ? `<img class="logo-img" src="${logo}" alt="Medilink">`
    : '<span class="logo-txt">medilink</span>';
  console.log(`[COTIZ-DEBUG] logoTag construido`);

  // ── Filas de bolsas ──────────────────────────────────────────────
  let bolsasRows = '';
  console.log(`[COTIZ-DEBUG] Iniciando bolsasRows, incluirWA=${incluirWA}, bolsas.wa=${bolsas.wa ? 'OK' : 'undefined'}`);

  if (incluirWA && bolsas.wa) {
    console.log(`[COTIZ-DEBUG] Entrando en sección WA bolsa...`);
    const b = bolsas.wa;
    console.log(`[COTIZ-DEBUG] b.wa object:`, JSON.stringify(b));
    console.log(`[COTIZ-DEBUG] b.tier=${b.tier}, b.limiteEnvios=${b.limiteEnvios}, b.precio=${b.precio}`);
    try {
      const limiteFormatted = fmtNum(b.limiteEnvios);
      console.log(`[COTIZ-DEBUG] limiteFormatted: ${limiteFormatted}`);
      const precioFormatted = fmt(b.precio, moneda);
      console.log(`[COTIZ-DEBUG] precioFormatted: ${precioFormatted}`);
      bolsasRows += `
      <tr class="row-even">
        <td class="td-desc">BOLSA WHATSAPP — RECORDATORIOS
          <span class="td-sub">Bolsa ${b.tier}: hasta ${limiteFormatted} envíos/mes</span></td>
        <td class="td-price">${precioFormatted}</td>
        <td class="td-price">${precioFormatted}</td>
        <td class="td-price">${precioFormatted}</td>
      </tr>`;
      console.log(`[COTIZ-DEBUG] Sección WA bolsa completada exitosamente`);
    } catch(e) {
      console.error(`[COTIZ-ERROR-WA] Error en sección WA: ${e.message}`);
      console.error(`[COTIZ-ERROR-WA] Stack: ${e.stack}`);
      throw e;
    }
  }
  if (incluirFirma && bolsas.firma) {
    const b = bolsas.firma;
    try {
      const limiteFormatted = fmtNum(b.limiteEnvios);
      const precioFormatted = fmt(b.precio, moneda);
      bolsasRows += `
      <tr class="row-odd">
        <td class="td-desc">BOLSA FIRMA ELECTRÓNICA
          <span class="td-sub">Bolsa ${b.tier}: hasta ${limiteFormatted} envíos/mes</span></td>
        <td class="td-price">${precioFormatted}</td>
        <td class="td-price">${precioFormatted}</td>
        <td class="td-price">${precioFormatted}</td>
      </tr>`;
    } catch(e) {
      console.error(`[COTIZ-ERROR-FIRMA] Error en sección Firma: ${e.message}`);
      console.error(`[COTIZ-ERROR-FIRMA] Stack: ${e.stack}`);
      throw e;
    }
  }
  if (incluirFactura && bolsas.factura) {
    const b = bolsas.factura;
    try {
      const limiteFormatted = fmtNum(b.limiteEnvios);
      const precioFormatted = fmt(b.precio, moneda);
      bolsasRows += `
      <tr class="row-even">
        <td class="td-desc">FACTURADOR ELECTRÓNICO
          <span class="td-sub">Bolsa ${b.tier}: hasta ${limiteFormatted} envíos/mes</span></td>
        <td class="td-price">${precioFormatted}</td>
        <td class="td-price">${precioFormatted}</td>
        <td class="td-price">${precioFormatted}</td>
      </tr>`;
    } catch(e) {
      console.error(`[COTIZ-ERROR-FACTURA] Error en sección Factura: ${e.message}`);
      console.error(`[COTIZ-ERROR-FACTURA] Stack: ${e.stack}`);
      throw e;
    }
  }
  if (incluirRecetaAR) {
    bolsasRows += `
      <tr class="row-odd">
        <td class="td-desc">RECETA DIGITAL AR
          <span class="td-sub">Módulo exclusivo Argentina — prescripción médica digital</span></td>
        <td class="td-price">${fmt(3, 'USD')}</td>
        <td class="td-price">${fmt(3, 'USD')}</td>
        <td class="td-price">${fmt(3, 'USD')}</td>
      </tr>`;
  }

  // ── Tabla de rangos de bolsas ────────────────────────────────────
  console.log(`[COTIZ-DEBUG] p.rangos =`, p.rangos ? JSON.stringify(p.rangos) : 'UNDEFINED');
  const rWA  = p.rangos.WA;
  const rFac = p.rangos.factura;
  const rFir = p.rangos.firma;
  console.log(`[COTIZ-DEBUG] rWA =`, rWA ? JSON.stringify(rWA) : 'UNDEFINED');
  console.log(`[COTIZ-DEBUG] rFac =`, rFac ? JSON.stringify(rFac) : 'UNDEFINED');
  console.log(`[COTIZ-DEBUG] rFir =`, rFir ? JSON.stringify(rFir) : 'UNDEFINED');

  let bolsasRangos = '';
  try {
    if (incluirWA)      bolsasRangos += `<tr><td>WhatsApp — Recordatorios</td><td><b>${fmtNum(enviosWA)}</b></td><td>${rWA.S}</td><td>${rWA.M}</td><td>${fmtNum(rWA.L)}</td><td>${fmtNum(rWA.XL)}</td></tr>`;
    if (incluirFactura) bolsasRangos += `<tr><td>Facturación Electrónica</td><td><b>${enviosFactFirm}</b></td><td>${rFac.S}</td><td>${rFac.M}</td><td>${rFac.L}</td><td>${rFac.XL}</td></tr>`;
    if (incluirFirma)   bolsasRangos += `<tr><td>Firma Electrónica</td><td><b>${enviosFactFirm}</b></td><td>${rFir.S}</td><td>${rFir.M}</td><td>${rFir.L}</td><td>${rFir.XL}</td></tr>`;
    console.log(`[COTIZ-DEBUG] bolsasRangos construida exitosamente`);
  } catch(e) {
    console.error(`[COTIZ-ERROR-RANGOS] Error en tabla de rangos: ${e.message}`);
    console.error(`[COTIZ-ERROR-RANGOS] Stack: ${e.stack}`);
    throw e;
  }

  let bolsasAsignadas = '';
  if (incluirWA && bolsas.wa)         bolsasAsignadas += `<tr><td>WhatsApp — Recordatorios</td><td>&#215;2/cita</td><td>${citasMes}</td><td>${fmtNum(enviosWA)} envíos</td><td><b>${bolsas.wa.tier}: hasta ${fmtNum(bolsas.wa.limiteEnvios)} envíos</b></td></tr>`;
  if (incluirFactura && bolsas.factura) bolsasAsignadas += `<tr><td>Facturación Electrónica</td><td>&#215;1/cita</td><td>${citasMes}</td><td>${enviosFactFirm} envíos</td><td><b>${bolsas.factura.tier}: hasta ${fmtNum(bolsas.factura.limiteEnvios)} envíos</b></td></tr>`;
  if (incluirFirma && bolsas.firma)   bolsasAsignadas += `<tr><td>Firma Electrónica</td><td>&#215;1/cita</td><td>${citasMes}</td><td>${enviosFactFirm} envíos</td><td><b>${bolsas.firma.tier}: hasta ${fmtNum(bolsas.firma.limiteEnvios)} envíos</b></td></tr>`;

  // ── Comparativa ──────────────────────────────────────────────────
  // Build dynamic features: add Argentina-specific items if needed
  const featuresForPais = FEATURES.map(sec => {
    if (sec.section === 'ATENCIÓN DE PACIENTES' && pais === 'ARGENTINA') {
      return {
        ...sec,
        items: [
          ...sec.items.filter(it => it.name !== 'Facturador electrónico'),
          { name: 'Receta Digital AR (excl. Argentina)', S:'A', M:'A', L:'A' }
        ]
      };
    }
    if (sec.section === 'ATENCIÓN DE PACIENTES' && pais !== 'ARGENTINA') {
      return {
        ...sec,
        items: sec.items.filter(it => it.name !== 'Receta Digital AR (excl. Argentina)')
      };
    }
    return sec;
  });

  let featRows = '';
  featuresForPais.forEach((sec) => {
    featRows += `<tr class="row-sec"><td colspan="4">${sec.section}</td></tr>`;
    sec.items.forEach((it, i) => {
      featRows += `<tr class="${i % 2 === 0 ? 'row-odd' : 'row-even'}"><td class="td-fn">${it.name}</td>${renderCell(it.S)}${renderCell(it.M)}${renderCell(it.L)}</tr>`;
    });
  });

  const usuariosStr = `${usuarios} ${usuarios === 1 ? 'usuario' : 'usuarios'}`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
@page{size:A4;margin:8mm 10mm}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:190mm;background:#fff}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;font-size:11px;color:#2c2c2c}

/* ── HEADER ── */
.hdr{display:flex;justify-content:space-between;align-items:center;padding:12px 24px 10px;border-top:4px solid #00AEEF;border-bottom:1px solid #d6f0fa;background:#fff}
.logo-img{height:40px;width:auto}
.logo-txt{font-size:22px;font-weight:900;color:#00AEEF;letter-spacing:.5px}
.hdr-r{text-align:right}
.hdr-title{font-size:32px;font-weight:900;letter-spacing:4px;color:#1A6B8A;line-height:1}
.hdr-sub{font-size:11px;font-weight:600;color:#007BA5;margin-top:3px;letter-spacing:.8px}
.hdr-date{font-size:9px;color:#9E9E9E;margin-top:2px}

/* ── META BAR ── */
.meta{background:#007BA5;display:flex}
.mi{flex:1;padding:7px 14px;border-right:1px solid rgba(255,255,255,.15)}
.mi:last-child{border-right:none}
.ml{font-size:7.5px;font-weight:600;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1.3px;margin-bottom:2px}
.mv{font-size:10.5px;font-weight:700;color:#fff}

/* ── SECTION ── */
.sec{padding:8px 24px}
.sec-t{font-size:10px;font-weight:700;color:#007BA5;text-transform:uppercase;letter-spacing:.8px;border-left:4px solid #00AEEF;padding:2px 0 2px 8px;margin-bottom:7px}

/* ── PRICING TABLE ── */
.pt{width:100%;border-collapse:collapse}
.pt thead th{background:#1A6B8A;color:#fff;padding:8px 11px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase}
.pt thead th:first-child{text-align:left;font-size:9px;letter-spacing:.4px}
.pt thead th:not(:first-child){text-align:center;border-left:1px solid rgba(255,255,255,.1)}
.row-odd td{background:#F5FCFF}
.row-even td{background:#DCF2FB}
.pt tbody td{padding:5px 11px;border-bottom:1px solid rgba(0,174,239,.1);vertical-align:middle}
.td-desc{font-size:9.5px;color:#2c2c2c;font-weight:500}
.td-sub{display:block;font-size:8px;color:#9E9E9E;font-weight:400;margin-top:1px}
.td-price{text-align:right;font-weight:700;font-size:10.5px;color:#1A6B8A}
.row-disc td{background:#C5EAF5!important;font-weight:700!important;border-bottom:1px solid rgba(0,144,195,.2)!important}
.row-disc .td-desc{color:#0090C3;font-style:italic}
.row-disc .td-price{color:#0090C3!important}
.bdg{display:inline-block;margin-left:6px;background:#0090C3;color:#fff;font-size:7.5px;font-weight:800;padding:1px 6px;border-radius:10px;vertical-align:middle;font-style:normal;letter-spacing:.4px}
.row-tp td{background:#1A6B8A!important;color:#fff!important;font-weight:800!important;font-size:12px!important;border-top:2px solid #00AEEF!important;border-bottom:none!important;padding:11px 13px!important}
.row-tn td{background:#007BA5!important;color:rgba(255,255,255,.82)!important;font-weight:600!important;font-size:10.5px!important;border-bottom:none!important}

/* ── BOLSAS CALC TABLE ── */
.ct{width:100%;border-collapse:collapse;margin-bottom:6px}
.ct th{background:#0090C3;color:#fff;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;padding:4px 8px;text-align:left}
.ct td{padding:4px 8px;font-size:9px;border-bottom:1px solid #DCF2FB;color:#2c2c2c}
.ct tr:nth-child(even) td{background:#F5FCFF}

/* ── QUE INCLUYE ── */
.inc-list{list-style:none;columns:2;column-gap:16px}
.inc-list li{padding:3px 0;font-size:9px;color:#2c2c2c;border-bottom:1px solid #DCF2FB;display:flex;align-items:flex-start;gap:4px;break-inside:avoid}
.ckn{color:#0090C3;font-weight:900;font-size:11px;flex-shrink:0;line-height:1.3}

/* ── TOKENS TABLE ── */
.tt{width:100%;border-collapse:collapse}
.tt thead th{background:#1A6B8A;color:#fff;font-size:9.5px;font-weight:700;letter-spacing:1px;padding:7px 11px;text-align:center}
.tt thead th:first-child{text-align:left}
.tt tbody td{padding:5px 11px;border-bottom:1px solid #DCF2FB;font-size:9.5px;text-align:center;color:#2c2c2c}
.tt tbody td:first-child{text-align:left;font-weight:500}
.tt tbody tr:nth-child(even) td{background:#DCF2FB}
.pill{display:inline-block;background:#00AEEF;color:#fff;font-size:10px;font-weight:800;padding:2px 11px;border-radius:20px}
.inc-b{color:#0090C3;font-weight:700}

/* ── FOOTER ── */
.ftr{padding:8px 24px 10px;border-top:2px solid #00AEEF;display:flex;align-items:center;justify-content:space-between;margin-top:4px}
.ftr-logo img{height:26px;width:auto;opacity:.75}
.ftr-logo .logo-txt{font-size:16px;font-weight:900;color:#00AEEF}
.ftr-cnt{text-align:center;font-size:9px;color:#9E9E9E}
.ftr-cnt strong{color:#007BA5;font-weight:700;font-size:10px}
.ftr-note{font-size:8px;color:#BDBDBD;text-align:right;max-width:175px;line-height:1.4}

/* ── NOTE ── */
.note{font-size:8.5px;color:#9E9E9E;margin-top:7px;line-height:1.5;font-style:italic}

/* ── PAGE 2 ── */
.pg2{page-break-before:always}
.cmp-hdr{padding:10px 24px 8px;border-top:4px solid #00AEEF}
.cmp-title{font-size:13px;font-weight:900;color:#1A6B8A;text-align:center;text-transform:uppercase;letter-spacing:2px;margin-bottom:2px}
.cmp-sub{font-size:8px;color:#9E9E9E;text-align:center}

.cmp{width:100%;border-collapse:collapse}
.cmp thead th{background:#1A6B8A;color:#fff;font-size:10px;font-weight:700;letter-spacing:1.2px;padding:8px 11px;text-align:center}
.cmp thead th:first-child{text-align:left;width:46%}
.row-sec td{background:#0090C3!important;color:#fff!important;font-size:9.5px!important;font-weight:800!important;text-transform:uppercase;letter-spacing:.8px;padding:6px 11px!important}
.cmp tbody .row-odd td{background:#F5FCFF}
.cmp tbody .row-even td{background:#fff}
.cmp tbody td{padding:5px 11px;border-bottom:1px solid rgba(0,174,239,.08);font-size:9.5px;text-align:center}
.cmp tbody td:first-child{text-align:left}
.td-fn{font-weight:500;color:#2c2c2c}
.cell-yes{background:#D6F0FA!important;color:#007BA5;font-weight:600}
.cell-no{color:#9E9E9E;font-weight:400}
.cell-add{background:#E8F5FD!important;color:#0090C3;font-weight:600}
.ck{font-weight:900;color:#00AEEF;margin-right:3px}
.ds{font-weight:400;color:#BDBDBD;margin-right:3px}
.pl{font-weight:900;color:#0090C3;margin-right:3px}
.cmp-fn{padding:10px 28px;font-size:8px;color:#9E9E9E;font-style:italic;text-align:center;border-top:1px solid #DCF2FB}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>

<!-- ═══════ PÁGINA 1 ═══════ -->

<div class="hdr">
  <div>${logoTag}</div>
  <div class="hdr-r">
    <div class="hdr-title">COTIZACIÓN</div>
    <div class="hdr-sub">MEDILINK SOFTWARE</div>
    <div class="hdr-date">Emitido: ${fecha}</div>
  </div>
</div>

<div class="meta">
  <div class="mi"><div class="ml">País</div><div class="mv">${pais}</div></div>
  <div class="mi"><div class="ml">Usuarios</div><div class="mv">${usuariosStr}</div></div>
  <div class="mi"><div class="ml">Dirigido a</div><div class="mv">${nombre}</div></div>
  <div class="mi"><div class="ml">Vigencia</div><div class="mv">${vigencia}</div></div>
</div>

<div class="sec">
  <table class="pt">
    <thead>
      <tr>
        <th style="width:44%">DETALLES / PLANES (MENSUAL)</th>
        <th style="width:18.7%">ESENCIAL</th>
        <th style="width:18.7%">PRO</th>
        <th style="width:18.6%">TITANIUM</th>
      </tr>
    </thead>
    <tbody>
      <tr class="row-odd">
        <td class="td-desc">SOFTWARE PLAN BASE (Licencia 1er Usuario)</td>
        <td class="td-price">${fmt(es.base, moneda)}</td>
        <td class="td-price">${fmt(pro.base, moneda)}</td>
        <td class="td-price">${fmt(ti.base, moneda)}</td>
      </tr>
      ${nAdic > 0 ? `
      <tr class="row-even">
        <td class="td-desc">USUARIOS ADICIONALES &#215; ${nAdic}</td>
        <td class="td-price">${fmt(es.precAdic * nAdic, moneda)}</td>
        <td class="td-price">${fmt(pro.precAdic * nAdic, moneda)}</td>
        <td class="td-price">${fmt(ti.precAdic * nAdic, moneda)}</td>
      </tr>` : ''}
      <tr class="row-disc">
        <td class="td-desc">DESCUENTO PROMO (Ahorro del &#8722;${descuento}%) <span class="bdg">&#8722;${descuento}%</span></td>
        <td class="td-price">&#8722; ${fmt(es.descuento, moneda)}</td>
        <td class="td-price">&#8722; ${fmt(pro.descuento, moneda)}</td>
        <td class="td-price">&#8722; ${fmt(ti.descuento, moneda)}</td>
      </tr>
      ${bolsasRows}
      <tr class="row-tp">
        <td>TOTAL MES 1 AL 3 (CON PROMO)</td>
        <td style="text-align:right">${fmt(es.totalPromo, moneda)}</td>
        <td style="text-align:right">${fmt(pro.totalPromo, moneda)}</td>
        <td style="text-align:right">${fmt(ti.totalPromo, moneda)}</td>
      </tr>
      <tr class="row-tn">
        <td>TOTAL DESDE MES 4 (Sin Promo)</td>
        <td style="text-align:right">${fmt(es.totalSinPromo, moneda)}</td>
        <td style="text-align:right">${fmt(pro.totalSinPromo, moneda)}</td>
        <td style="text-align:right">${fmt(ti.totalSinPromo, moneda)}</td>
      </tr>
    </tbody>
  </table>
  <p class="note">Nota: Las bolsas de módulos son opcionales. Puede aumentarlas, disminuirlas o eliminarlas según su volumen real. Los precios de la promoción base permanecen vigentes independientemente.</p>
</div>

<div class="sec" style="padding-top:4px">
  <div class="sec-t">Cómo se calculan las bolsas</div>
  <p style="font-size:9px;color:#555;margin-bottom:8px;line-height:1.5">Las bolsas propuestas son según la cantidad de citas/mes de la clínica (${citasMes} citas con ${usuarios} profesional${usuarios > 1 ? 'es' : ''}). Cada módulo tiene su propia bolsa asignada independientemente:</p>
  <table class="ct">
    <thead><tr><th style="width:32%">Módulo</th><th>Envíos requeridos</th><th>S (hasta...)</th><th>M (hasta...)</th><th>L (hasta...)</th><th>XL (hasta...)</th></tr></thead>
    <tbody>${bolsasRangos}</tbody>
  </table>
  <table class="ct">
    <thead><tr><th style="width:32%">Módulo</th><th>×/Cita</th><th>Citas/mes</th><th>Envíos requeridos</th><th>Bolsa asignada</th></tr></thead>
    <tbody>${bolsasAsignadas}</tbody>
  </table>
</div>

<div class="sec" style="padding-top:4px">
  <div class="sec-t">Qué incluye su plan</div>
  <ul class="inc-list">
    <li><span class="ckn">&#10003;</span> Historias Clínicas 100% personalizables por especialidad.</li>
    <li><span class="ckn">&#10003;</span> Agenda Online + link de auto-agendamiento para pacientes.</li>
    <li><span class="ckn">&#10003;</span> ${usuariosStr} médico${usuarios > 1 ? 's' : ''} + usuarios administrativos ilimitados, sin costo adicional.</li>
    <li><span class="ckn">&#10003;</span> Normativa local: privacidad de fichas clínicas + Telemedicina legal.</li>
    <li><span class="ckn">&#10003;</span> Contact Center IA: 2 meses gratis (requiere WhatsApp Business con tarjeta META).</li>
    <li><span class="ckn">&#10003;</span> Telemedicina: videoconsultas ilimitadas sin costo adicional.</li>
    <li><span class="ckn">&#10003;</span> Certificado de validez legal firmado por Ingeniero en Sistemas.</li>
    <li><span class="ckn">&#10003;</span> Certificación ISO 27001 — Protección total de su información clínica.</li>
    <li><span class="ckn">&#10003;</span> Acompañamiento con Clases y Capacitaciones Virtuales + Soporte.</li>
  </ul>
</div>

<div class="sec" style="padding-top:4px">
  <div class="sec-t">Tokens de IA incluidos por plan</div>
  <table class="tt">
    <thead><tr><th style="width:44%">CAPACIDAD / FUNCIÓN</th><th>ESENCIAL</th><th>PRO</th><th>TITANIUM</th></tr></thead>
    <tbody>
      <tr><td>Tokens Mensuales Incluidos</td><td><span class="pill">80</span></td><td><span class="pill">250</span></td><td><span class="pill">400</span></td></tr>
      <tr><td>Dictado por Voz con IA</td><td><span class="inc-b">&#10003; Incluido</span></td><td><span class="inc-b">&#10003; Incluido</span></td><td><span class="inc-b">&#10003; Incluido</span></td></tr>
      <tr><td>Resumen Clínico Automático</td><td><span class="inc-b">&#10003; Incluido</span></td><td><span class="inc-b">&#10003; Incluido</span></td><td><span class="inc-b">&#10003; Incluido</span></td></tr>
      <tr><td>Contralor IA</td><td><span class="inc-b">&#10003; Incluido</span></td><td><span class="inc-b">&#10003; Incluido</span></td><td><span class="inc-b">&#10003; Incluido</span></td></tr>
    </tbody>
  </table>
  <p class="note">Nota: La diferencia entre planes es la cantidad de tokens disponibles para operar estas funciones. A mayor plan, más operaciones simultáneas y avanzadas.</p>
</div>

<div class="ftr">
  <div class="ftr-logo">${logo ? `<img src="${logo}" alt="Medilink">` : '<span class="logo-txt">medilink</span>'}</div>
  <div class="ftr-cnt"><strong>Asesor: MARIANO</strong><br>mariano.destefano@healthatom.com &nbsp;|&nbsp; WhatsApp: +56 9 2855 2569</div>
  <div class="ftr-note">Documento confidencial. Valores sujetos a Tasa de Cambio del día de facturación. Cotización válida hasta: ${vigencia.split('—')[0].trim()}.</div>
</div>


<!-- ═══════ PÁGINA 2 ═══════ -->
<div class="pg2">
  <div class="cmp-hdr">
    <div class="cmp-title">Compara las funcionalidades de todos los planes</div>
    <div class="cmp-sub">Todas las funcionalidades anteriores están incluidas en los tres planes. Los módulos marcados como "Adicional" tienen un costo extra (bolsa de envíos). Medilink se reserva el derecho de actualizar su catálogo de funcionalidades.</div>
  </div>
  <div style="padding:0 24px 10px">
    <table class="cmp">
      <thead><tr><th>FUNCIONALIDAD</th><th>ESENCIAL</th><th>PRO</th><th>TITANIUM</th></tr></thead>
      <tbody>${featRows}</tbody>
    </table>
  </div>
  <div class="ftr" style="margin-top:0">
    <div class="ftr-logo">${logo ? `<img src="${logo}" alt="Medilink">` : '<span class="logo-txt">medilink</span>'}</div>
    <div class="ftr-cnt"><strong>Asesor: MARIANO</strong><br>mariano.destefano@healthatom.com &nbsp;|&nbsp; WhatsApp: +56 9 2855 2569</div>
    <div class="ftr-note">Medilink se reserva el derecho de actualizar su catálogo de funcionalidades.</div>
  </div>
</div>

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────
// GENERAR PDF
// ─────────────────────────────────────────────────────────────────────

async function generarPDF(params) {
  console.log(`[PDF-INIT] generarPDF iniciado, puppeteer available: ${!!puppeteer}`);
  if (!puppeteer) throw new Error('puppeteer no instalado — PDF no disponible');
  let browser;
  try {
    console.log(`[PDF-INIT] Llamando buildHTML...`);
    const html = buildHTML(params);
    console.log(`[PDF-INIT] buildHTML completado, html length: ${html.length}`);
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    console.log(`[PDF-INIT] setContent iniciado...`);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`[PDF-INIT] setContent completado, generando PDF...`);
    const pdfResult = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      timeout: 30000
    });
    if (!pdfResult) {
      throw new Error('page.pdf() retornó null/undefined');
    }
    const buffer = Buffer.isBuffer(pdfResult) ? pdfResult : Buffer.from(pdfResult);
    console.log(`[PDF-INIT] PDF generado exitosamente, size: ${buffer.length} bytes`);
    return buffer;
  } catch (e) {
    console.error(`[PDF-INIT] Error generando PDF:`, e.message);
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────
// ENVIAR POR WHATSAPP
// ─────────────────────────────────────────────────────────────────────

async function enviarCotizacionWA(sock, phone, params) {
  const buffer       = await generarPDF(params);
  const nombreLimpio = (params.nombre || 'Lead').replace(/[^a-zA-Z0-9]/g, '_');

  const primerNombre = (params.nombre || 'Doctor').split(' ')[0];
  const vigencia     = params.vigencia || '';
  const usuarios     = params.usuarios || 1;
  const citasMes     = params.citasMes || 0;

  const caption =
`Perfecto, ${primerNombre}. Aquí va la cotización Medilink personalizada.

Para tu operación de ${citasMes} citas/mes con ${usuarios} profesional${usuarios !== 1 ? 'es' : ''}, el plan *Esencial* es el punto de partida ideal, con posibilidad de escalar cuando lo necesites.

Con la promoción activa del *30% de descuento* vigente hasta el ${vigencia}, este es el mejor momento para arrancar.

Si querés ver la plataforma en acción, agendá directamente aquí:
https://meetings.hubspot.com/marianodestefano/demomedilink

Quedo atento.`;

  // Baileys API: send document with caption
  await sock.sendMessage(phone, {
    document: buffer,
    mimetype: 'application/pdf',
    fileName: `Cotizacion_Medilink_${nombreLimpio}.pdf`,
    caption
  });
}

// ─────────────────────────────────────────────────────────────────────
module.exports = { calcularCotizacion, generarPDF, enviarCotizacionWA, buildHTML, PRECIOS, fmt };
