#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// FASE C.1 — Generador de 8 mocks MediLink (C-342 ADENDA 2)
// ─────────────────────────────────────────────────────────────────────
// Uso:
//   MIIA_INTERNAL_TOKEN=xxx TENANT_ID=bq2BbtCVF8cZo30tum584zrGATJ3 \
//     node scripts/generate_8_mocks_fase_c.js
//
// Países firmados en C-342 ADENDA 2: CO/MX/CL/AR/DO/ES/PE/EC (US descartado)
// Todos con: plan esencial, 1 usuario, 70 citas/mes, sin bolsas, modalidad mensual.
// ─────────────────────────────────────────────────────────────────────

const RAILWAY_URL = 'https://miia-backend-production.up.railway.app';
const TOKEN       = process.env.MIIA_INTERNAL_TOKEN;
const TENANT_ID   = process.env.TENANT_ID || 'bq2BbtCVF8cZo30tum584zrGATJ3';

if (!TOKEN) {
  console.error('❌ Falta MIIA_INTERNAL_TOKEN en env. Exportalo y re-ejecutá.');
  process.exit(1);
}

// 8 países × 1 usuario × plan esencial × 70 citas/mes
const PAISES = [
  { code: 'CO', name: 'Colombia',     phone: '+573001234567', currency: 'COP' },
  { code: 'MX', name: 'Mexico',       phone: '+525512345678', currency: 'MXN' },
  { code: 'CL', name: 'Chile',        phone: '+56912345678',  currency: 'CLP' },
  { code: 'AR', name: 'Argentina',    phone: '+5491112345678',currency: 'USD' },
  { code: 'DO', name: 'Republica_Dominicana', phone: '+18091234567', currency: 'USD' },
  { code: 'ES', name: 'Espana',       phone: '+34612345678',  currency: 'EUR' },
  { code: 'PE', name: 'Peru',         phone: '+51987654321',  currency: 'USD' },
  { code: 'EC', name: 'Ecuador',      phone: '+593987654321', currency: 'USD' },
];

async function generarMock(pais) {
  const body = {
    tenant_id:  TENANT_ID,
    lead_name:  `Mock ${pais.code} 1usr`,
    lead_phone: pais.phone,
    params: {
      plan:      'esencial',
      users:     1,
      modalidad: 'mensual',
      country:   pais.code,
      currency:  pais.currency,
      modulos: {
        wa:      { on: false, tier: -1 },
        firma:   { on: false, tier: -1 },
        factura: { on: false, tier: -1 },
      },
      citasMes:        70,
      descuentoCustom: null,
      usuariosBonus:   0,
    },
    expires_days: 30,
  };

  const res = await fetch(`${RAILWAY_URL}/api/cotizacion/generate`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    return { pais: pais.code, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
  }

  const data = await res.json();
  return { pais: pais.code, name: pais.name, url: data.url, hash: data.hash, expires: data.expires_at };
}

(async () => {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`FASE C.1 — 8 mocks MediLink (C-342 ADENDA 2)`);
  console.log(`Tenant:  ${TENANT_ID}`);
  console.log(`Railway: ${RAILWAY_URL}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  const results = [];
  for (const pais of PAISES) {
    process.stdout.write(`${pais.code} ${pais.name.padEnd(25)} ... `);
    try {
      const r = await generarMock(pais);
      if (r.error) {
        console.log(`❌ ${r.error}`);
      } else {
        console.log(`✅ ${r.url}`);
      }
      results.push(r);
    } catch (e) {
      console.log(`❌ ${e.message}`);
      results.push({ pais: pais.code, error: e.message });
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`RESUMEN — URLs listas para abrir en el navegador:`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  results.forEach(r => {
    if (r.url) console.log(`  ${r.pais}: ${r.url}`);
    else       console.log(`  ${r.pais}: ❌ ${r.error}`);
  });
  console.log(``);
})();
