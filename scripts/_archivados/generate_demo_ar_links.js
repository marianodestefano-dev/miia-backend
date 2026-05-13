#!/usr/bin/env node
// Genera 2 links AR demo:
//   1) AR normal (demo recetas + tiles simplificados)
//   2) AR con lockPlan=titanium (demo segmentacion estetica/derma)

const RAILWAY_URL = 'https://miia-backend-production.up.railway.app';
const TOKEN       = process.env.MIIA_INTERNAL_TOKEN;
const TENANT_ID   = process.env.TENANT_ID || 'bq2BbtCVF8cZo30tum584zrGATJ3';

if (!TOKEN) { console.error('❌ Falta MIIA_INTERNAL_TOKEN'); process.exit(1); }

async function gen(label, body) {
  const res = await fetch(`${RAILWAY_URL}/api/cotizacion/generate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { console.log(`❌ ${label}: HTTP ${res.status} — ${(await res.text()).slice(0,200)}`); return; }
  const d = await res.json();
  console.log(`✅ ${label}`);
  console.log(`   ${d.url}\n`);
}

(async () => {
  const base = {
    tenant_id:  TENANT_ID,
    lead_name:  'Mock AR demo',
    lead_phone: '+5491112345678',
    expires_days: 30,
  };

  // 1) AR normal — demo recetas + tiles
  await gen('AR — demo recetas digitales + tiles', {
    ...base,
    lead_name: 'Mock AR — recetas demo',
    params: {
      plan: 'pro', users: 2, modalidad: 'mensual',
      country: 'AR', currency: 'USD',
      modulos: {
        wa:      { on: true,  tier: 0 },
        firma:   { on: true,  tier: 0 },
        factura: { on: false, tier: -1 },
      },
      citasMes: 70, descuentoCustom: null, usuariosBonus: 0,
    },
  });

  // 2) AR con lockPlan=titanium — demo estetica/derma
  await gen('AR — demo estetica/derma (solo Titanium)', {
    ...base,
    lead_name: 'Mock AR — centro estetico',
    params: {
      plan: 'titanium', users: 2, modalidad: 'mensual',
      country: 'AR', currency: 'USD',
      lockPlan: 'titanium',
      modulos: {
        wa:      { on: true,  tier: 0 },
        firma:   { on: true,  tier: 0 },
        factura: { on: false, tier: -1 },
      },
      citasMes: 70, descuentoCustom: null, usuariosBonus: 0,
    },
  });
})();
