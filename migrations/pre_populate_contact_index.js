'use strict';

/**
 * MIGRACIÓN T-A (C-293) — Pre-poblar contact_index + purgar cache Bug 6.19
 *
 * Contexto: antes del broadcast MIIA_PRESENTATE (T1/T2/T3) hay que pre-poblar
 * `users/{A5p UID}/contact_index/{phone}` con el `contact_type` correcto
 * (friend_broadcast / medilink_team) para que `classifyContact()` PASO 0
 * identifique al contacto y NO aplique SALES_PROFILE.
 *
 * Además purga el cache `ctx.contactTypes[phone]` persistido en
 * `miia_persistent/tenant_conversations` para los 39 phones (fix Bug 6.19).
 *
 * IDEMPOTENTE: `merge: true` en todas las escrituras.
 * DRY-RUN: pasar --dry-run para ver el diff sin escribir.
 *
 * Uso:
 *   node migrations/pre_populate_contact_index.js
 *   node migrations/pre_populate_contact_index.js --dry-run
 *   node migrations/pre_populate_contact_index.js --uid=OTRO_UID
 */

const admin = require('firebase-admin');
const path = require('path');
const { initFirebase: initFirebaseShared } = require('../lib/firebase_init');

const DRY_RUN = process.argv.includes('--dry-run');
const UID_ARG = process.argv.find(a => a.startsWith('--uid='));
const OWNER_UID = UID_ARG ? UID_ARG.split('=')[1] : 'A5pMESWlfmPWCoCPRbwy85EzUzy2'; // MIIA CENTER

// ═══════════════════════════════════════════════════════════════════════════
// FUENTE CANÓNICA DE LOS 39 DESTINATARIOS (C-285 + correcciones C-286)
// Kamila y Liliana en T2. Vivi en T3 con isBoss=true.
// Mariano (+573163937365) figura como #1 de T1 para self-presentación.
// ═══════════════════════════════════════════════════════════════════════════
const CONTACTS = [
  // T1 — FAMILIA + CERCANOS (13) — contact_type: 'friend_broadcast'
  { phone: '573163937365', name: 'Mariano',       tanda: 'T1', country: 'CO', relation: 'owner_personal' },
  { phone: '573137501884', name: 'Alejandra',     tanda: 'T1', country: 'CO', relation: 'esposa' },
  { phone: '5491131313325', name: 'Sr. Rafael',   tanda: 'T1', country: 'AR', relation: 'papá' },
  { phone: '5491164431700', name: 'Silvia',       tanda: 'T1', country: 'AR', relation: 'mamá' },
  { phone: '5491134236348', name: 'Anabella',     tanda: 'T1', country: 'AR', relation: 'hermana' },
  { phone: '5491140293119', name: 'Chapy',        tanda: 'T1', country: 'AR', relation: 'primo' },
  { phone: '573217976029', name: 'Consu',         tanda: 'T1', country: 'CO', relation: 'suegra' },
  { phone: '573145868362', name: 'Juancho',       tanda: 'T1', country: 'CO', relation: 'cuñado' },
  { phone: '573108221373', name: 'Maria Clara',   tanda: 'T1', country: 'CO', relation: 'concuñada' },
  { phone: '573128908895', name: 'Jota',          tanda: 'T1', country: 'CO', relation: 'hermano_ale' },
  { phone: '573012761138', name: 'Maria Isabel',  tanda: 'T1', country: 'CO', relation: 'esposa_jota' },
  { phone: '556298316219', name: 'Flako',         tanda: 'T1', country: 'BR', relation: 'amigo_papa' },
  { phone: '5492235160564', name: 'Edi',          tanda: 'T1', country: 'AR', relation: 'cercano' },
  // T2 — AMIGOS MARIANO (14) — contact_type: 'friend_broadcast'
  { phone: '573014822744', name: 'Kamila',        tanda: 'T2', country: 'CO', relation: 'amiga' },
  { phone: '573015392753', name: 'Liliana',       tanda: 'T2', country: 'CO', relation: 'amiga' },
  { phone: '573148966945', name: 'Carlos',        tanda: 'T2', country: 'CO', relation: 'amigo' },
  { phone: '573006080414', name: 'Daniel',        tanda: 'T2', country: 'CO', relation: 'amigo' },
  { phone: '573127310503', name: 'Isabel',        tanda: 'T2', country: 'CO', relation: 'amiga' },
  { phone: '573106411722', name: 'Natalia',       tanda: 'T2', country: 'CO', relation: 'amiga' },
  { phone: '573213428069', name: 'Sandra',        tanda: 'T2', country: 'CO', relation: 'amiga' },
  { phone: '573136727447', name: 'Isa',           tanda: 'T2', country: 'CO', relation: 'amiga' },
  { phone: '573013352846', name: 'Kevin',         tanda: 'T2', country: 'CO', relation: 'amigo' },
  { phone: '5491170678528', name: 'Julia',        tanda: 'T2', country: 'AR', relation: 'amiga' },
  { phone: '5491149474787', name: 'Ana Suarez',   tanda: 'T2', country: 'AR', relation: 'amiga' },
  { phone: '5491126411120', name: 'Jonatan',      tanda: 'T2', country: 'AR', relation: 'amigo' },
  { phone: '5491130240371', name: 'Soledad',      tanda: 'T2', country: 'AR', relation: 'amiga' },
  { phone: '56978881618', name: 'Ignacio',        tanda: 'T2', country: 'CL', relation: 'amigo' },
  // T3 — EQUIPO MEDILINK (12) — contact_type: 'medilink_team'
  { phone: '56971251474', name: null,             tanda: 'T3', country: 'CL', relation: 'equipo_medilink' },
  { phone: '56964490945', name: null,             tanda: 'T3', country: 'CL', relation: 'equipo_medilink' },
  { phone: '56971561322', name: null,             tanda: 'T3', country: 'CL', relation: 'equipo_medilink' },
  { phone: '56974919305', name: null,             tanda: 'T3', country: 'CL', relation: 'equipo_medilink' },
  { phone: '56978516275', name: null,             tanda: 'T3', country: 'CL', relation: 'equipo_medilink' },
  { phone: '56989558306', name: null,             tanda: 'T3', country: 'CL', relation: 'equipo_medilink' },
  { phone: '56994128069', name: 'Vivi',           tanda: 'T3', country: 'CL', relation: 'jefa', isBoss: true },
  { phone: '56974777648', name: null,             tanda: 'T3', country: 'CL', relation: 'equipo_medilink' },
  { phone: '573125027604', name: null,            tanda: 'T3', country: 'CO', relation: 'equipo_medilink' },
  { phone: '573108447586', name: null,            tanda: 'T3', country: 'CO', relation: 'equipo_medilink' },
  { phone: '573175058386', name: null,            tanda: 'T3', country: 'CO', relation: 'equipo_medilink' },
  { phone: '573014259700', name: null,            tanda: 'T3', country: 'CO', relation: 'equipo_medilink' },
];

function contactTypeFor(c) {
  return c.tanda === 'T3' ? 'medilink_team' : 'friend_broadcast';
}

async function initFirebase() {
  const ok = initFirebaseShared({ backendRoot: path.join(__dirname, '..') });
  if (!ok) {
    console.error('[FIREBASE] ❌ No se encontró credencial.');
    process.exit(1);
  }
}

async function main() {
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  T-A — Pre-populate contact_index + purga cache 6.19`);
  console.log(`  UID (tenant): ${OWNER_UID}`);
  console.log(`  Destinatarios: ${CONTACTS.length}`);
  console.log(`  Modo: ${DRY_RUN ? '🔍 DRY-RUN' : '🔥 ESCRITURA REAL'}`);
  console.log(`══════════════════════════════════════════════\n`);

  await initFirebase();
  const db = admin.firestore();
  const userRef = db.collection('users').doc(OWNER_UID);

  // PASO 1: Escribir contact_index por cada phone
  let writtenCI = 0;
  let skippedCI = 0;
  const ciRef = userRef.collection('contact_index');
  for (const c of CONTACTS) {
    const ct = contactTypeFor(c);
    const doc = {
      phone: c.phone,
      name: c.name || null,
      // type = canal usado por classifyContact() en TMH:730 para routing de prompt.
      // contact_type = alias semántico (mismo valor, mantenido por compatibilidad con chatType del postprocess).
      type: ct,
      contact_type: ct,
      tanda: c.tanda,
      country: c.country,
      relation: c.relation,
      status: 'classified',
      source: 'pre_populate_t_a_c293',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (c.isBoss) doc.isBoss = true;

    console.log(`  📱 ${c.phone.padEnd(14)} [${c.tanda}] ${contactTypeFor(c).padEnd(18)} ${c.name || '(sin nombre)'}${c.isBoss ? ' 👑' : ''}${DRY_RUN ? ' (dry)' : ''}`);
    if (!DRY_RUN) {
      await ciRef.doc(c.phone).set(doc, { merge: true });
      writtenCI++;
    } else {
      writtenCI++;
    }
  }

  // PASO 2: Purga Bug 6.19 — borrar ctx.contactTypes[phone] persistido para los 39 phones
  console.log(`\n[PASO 2] Bug 6.19 — purga cache contactTypes en miia_persistent/tenant_conversations`);
  const convRef = userRef.collection('miia_persistent').doc('tenant_conversations');
  const convDoc = await convRef.get();
  let purgedCT = 0;

  if (convDoc.exists) {
    const data = convDoc.data() || {};
    const ctMap = data.contactTypes || {};
    const updated = { ...ctMap };
    for (const c of CONTACTS) {
      const candidates = [
        c.phone,
        `${c.phone}@s.whatsapp.net`,
      ];
      for (const k of candidates) {
        if (k in updated) {
          delete updated[k];
          purgedCT++;
          console.log(`   🧹 purgado cache[${k}]`);
        }
      }
    }
    if (purgedCT > 0 && !DRY_RUN) {
      await convRef.set({ contactTypes: updated }, { merge: true });
      console.log(`[PASO 2] ✅ ${purgedCT} entradas purgadas del cache`);
    } else if (purgedCT > 0) {
      console.log(`[PASO 2] 🔍 (dry-run) Se purgarían ${purgedCT} entradas`);
    } else {
      console.log(`[PASO 2] ✅ Nada que purgar (ninguno de los 39 phones estaba cacheado)`);
    }
  } else {
    console.log(`[PASO 2] ℹ️ Doc miia_persistent/tenant_conversations no existe — nada que purgar`);
  }

  // PASO 3: Verificación rápida (read-back) — solo en modo real
  if (!DRY_RUN) {
    console.log(`\n[PASO 3] Read-back (3 muestras aleatorias)`);
    const samples = [CONTACTS[0], CONTACTS[Math.floor(CONTACTS.length / 2)], CONTACTS[CONTACTS.length - 1]];
    for (const s of samples) {
      const snap = await ciRef.doc(s.phone).get();
      if (snap.exists) {
        const d = snap.data();
        console.log(`   ✅ ${s.phone} → contact_type=${d.contact_type} tanda=${d.tanda} name=${d.name || '(null)'}`);
      } else {
        console.error(`   ❌ ${s.phone} NO escribió — falla silenciosa`);
      }
    }
  }

  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  RESULTADO:`);
  console.log(`  • contact_index escritos: ${writtenCI} / ${CONTACTS.length}`);
  console.log(`  • cache contactTypes purgados: ${purgedCT}`);
  if (DRY_RUN) console.log(`  ⚠️ DRY-RUN — nada se escribió realmente`);
  console.log(`══════════════════════════════════════════════\n`);

  process.exit(0);
}

main().catch(e => {
  console.error('[T-A] ❌ Error fatal:', e);
  process.exit(1);
});
