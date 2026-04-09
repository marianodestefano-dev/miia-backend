'use strict';

/**
 * MIIA SELF-TEST v1.0 — Verificación automática de salud al arrancar
 *
 * Se ejecuta al iniciar server.js y verifica:
 * 1. Conectividad Firebase/Firestore
 * 2. Conectividad IA (Gemini)
 * 3. Datos críticos del admin (owner profile, training data, businesses)
 * 4. Integridad de cerebro(s)
 * 5. Estado de contact_rules
 * 6. Agenda funcional
 * 7. Memory/CPU baseline
 *
 * Si detecta problemas → loguea + notifica al owner via self-chat
 *
 * Costo: $0 (1 llamada Gemini Flash al arrancar)
 */

const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════════════
// CHECKS
// ═══════════════════════════════════════════════════════════════════

const results = [];

function logResult(name, status, detail) {
  const emoji = status === 'OK' ? '✅' : status === 'WARN' ? '⚠️' : '❌';
  results.push({ name, status, detail, emoji });
  console.log(`[SELF-TEST] ${emoji} ${name}: ${detail}`);
}

/**
 * Check 1: Firestore connectivity
 */
async function checkFirestore() {
  try {
    const start = Date.now();
    const snap = await admin.firestore().collection('_selftest').doc('ping').get();
    const ms = Date.now() - start;
    if (ms > 5000) {
      logResult('Firestore', 'WARN', `Conectado pero lento (${ms}ms)`);
    } else {
      logResult('Firestore', 'OK', `Conectado (${ms}ms)`);
    }
    return true;
  } catch (e) {
    logResult('Firestore', 'FAIL', `No conecta: ${e.message}`);
    return false;
  }
}

/**
 * Check 2: IA connectivity (Gemini)
 */
async function checkAI(aiGateway) {
  if (!aiGateway) {
    logResult('IA Gateway', 'WARN', 'No se pasó aiGateway — skip');
    return true;
  }
  try {
    const start = Date.now();
    const result = await aiGateway.smartCall(
      aiGateway.CONTEXTS?.GENERAL || 'general',
      'Responde SOLO con la palabra "OK". Nada más.',
      {},
      { maxTokens: 10, timeout: 10000 }
    );
    const ms = Date.now() - start;
    if (result?.text?.toLowerCase().includes('ok')) {
      logResult('IA Gateway', 'OK', `Gemini responde (${ms}ms)`);
    } else {
      logResult('IA Gateway', 'WARN', `Gemini respondió pero raro: "${(result?.text || '').substring(0, 50)}" (${ms}ms)`);
    }
    return true;
  } catch (e) {
    logResult('IA Gateway', 'FAIL', `IA no responde: ${e.message}`);
    return false;
  }
}

/**
 * Check 3: Admin owner data (MIIA CENTER)
 */
async function checkAdminData(ownerUid) {
  if (!ownerUid) {
    logResult('Admin Data', 'WARN', 'No se pasó ownerUid — skip');
    return true;
  }
  try {
    const userDoc = await admin.firestore().collection('users').doc(ownerUid).get();
    if (!userDoc.exists) {
      logResult('Admin Data', 'FAIL', `Owner ${ownerUid} no existe en Firestore`);
      return false;
    }
    const data = userDoc.data();
    const checks = [];
    if (!data.name) checks.push('sin nombre');
    if (!data.email) checks.push('sin email');
    if (!data.defaultBusinessId) checks.push('sin defaultBusinessId');

    if (checks.length > 0) {
      logResult('Admin Data', 'WARN', `Owner encontrado pero: ${checks.join(', ')}`);
    } else {
      logResult('Admin Data', 'OK', `${data.name} (${data.email}) — defaultBiz: ${data.defaultBusinessId}`);
    }
    return true;
  } catch (e) {
    logResult('Admin Data', 'FAIL', `Error leyendo admin: ${e.message}`);
    return false;
  }
}

/**
 * Check 4: Businesses + cerebros
 */
async function checkBusinesses(ownerUid) {
  if (!ownerUid) return true;
  try {
    const bizSnap = await admin.firestore().collection('users').doc(ownerUid).collection('businesses').get();
    if (bizSnap.empty) {
      logResult('Businesses', 'WARN', 'Sin negocios registrados');
      return true;
    }
    let allOk = true;
    for (const doc of bizSnap.docs) {
      const biz = doc.data();
      const brainDoc = await admin.firestore()
        .collection('users').doc(ownerUid)
        .collection('businesses').doc(doc.id)
        .collection('brain').doc('business_cerebro').get();
      const rulesDoc = await admin.firestore()
        .collection('users').doc(ownerUid)
        .collection('businesses').doc(doc.id)
        .collection('contact_rules').doc('rules').get();

      const brainSize = brainDoc.exists ? (brainDoc.data()?.content || '').length : 0;
      const hasRules = rulesDoc.exists;
      const issues = [];
      if (brainSize === 0) issues.push('cerebro vacío');
      if (!hasRules) issues.push('sin contact_rules');
      if (!biz.description) issues.push('sin descripción');

      if (issues.length > 0) {
        logResult(`Biz: ${biz.name || doc.id}`, 'WARN', issues.join(', '));
        allOk = false;
      } else {
        logResult(`Biz: ${biz.name || doc.id}`, 'OK', `cerebro=${brainSize}chars, rules=✅, desc=✅`);
      }
    }
    return allOk;
  } catch (e) {
    logResult('Businesses', 'FAIL', `Error: ${e.message}`);
    return false;
  }
}

/**
 * Check 5: Personal brain
 */
async function checkPersonalBrain(ownerUid) {
  if (!ownerUid) return true;
  try {
    const brainDoc = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('personal').doc('personal_brain').get();
    if (!brainDoc.exists || !(brainDoc.data()?.content || '').length) {
      logResult('Personal Brain', 'WARN', 'Cerebro personal vacío o inexistente');
      return true;
    }
    logResult('Personal Brain', 'OK', `${(brainDoc.data().content || '').length} chars`);
    return true;
  } catch (e) {
    logResult('Personal Brain', 'FAIL', `Error: ${e.message}`);
    return false;
  }
}

/**
 * Check 6: Memory baseline
 */
function checkMemory() {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  if (heapMB > 400) {
    logResult('Memory', 'WARN', `heap=${heapMB}MB, rss=${rssMB}MB — alto al arrancar`);
  } else {
    logResult('Memory', 'OK', `heap=${heapMB}MB, rss=${rssMB}MB`);
  }
  return true;
}

/**
 * Check 7: Pending agenda events integrity
 */
async function checkAgendaIntegrity(ownerUid) {
  if (!ownerUid) return true;
  try {
    const snap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_agenda')
      .where('status', '==', 'pending')
      .limit(20)
      .get();

    let brokenCount = 0;
    for (const doc of snap.docs) {
      const evt = doc.data();
      if (!evt.reason || !evt.contactPhone || !evt.scheduledFor) {
        brokenCount++;
      }
    }

    if (brokenCount > 0) {
      logResult('Agenda', 'WARN', `${brokenCount}/${snap.size} eventos pendientes incompletos (sin reason/contactPhone/scheduledFor)`);
    } else {
      logResult('Agenda', 'OK', `${snap.size} eventos pendientes, todos válidos`);
    }
    return true;
  } catch (e) {
    logResult('Agenda', 'FAIL', `Error: ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ═══════════════════════════════════════════════════════════════════

/**
 * Ejecutar todos los self-tests.
 * @param {object} opts
 * @param {string} opts.ownerUid - UID del admin
 * @param {object} [opts.aiGateway] - Instancia de ai_gateway
 * @param {function} [opts.notifySelfChat] - async (message) => void
 * @returns {Promise<{ passed: boolean, results: object[], summary: string }>}
 */
async function runSelfTest(opts = {}) {
  const { ownerUid, aiGateway, notifySelfChat } = opts;
  results.length = 0; // Reset

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  MIIA SELF-TEST v1.0 — Verificación de arranque`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Ejecutar checks en orden
  await checkFirestore();
  await checkAI(aiGateway);
  await checkAdminData(ownerUid);
  await checkBusinesses(ownerUid);
  await checkPersonalBrain(ownerUid);
  checkMemory();
  await checkAgendaIntegrity(ownerUid);

  // Resumen
  const fails = results.filter(r => r.status === 'FAIL');
  const warns = results.filter(r => r.status === 'WARN');
  const oks = results.filter(r => r.status === 'OK');

  const passed = fails.length === 0;
  const overallEmoji = fails.length > 0 ? '🔴' : warns.length > 0 ? '🟡' : '🟢';

  const summary = `${overallEmoji} Self-test: ${oks.length} OK, ${warns.length} WARN, ${fails.length} FAIL`;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${summary}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Si hay fallos críticos, notificar al owner
  if (fails.length > 0 && notifySelfChat) {
    const failList = fails.map(f => `❌ ${f.name}: ${f.detail}`).join('\n');
    const warnList = warns.length > 0 ? `\n${warns.map(w => `⚠️ ${w.name}: ${w.detail}`).join('\n')}` : '';
    try {
      await notifySelfChat(
        `🔴 *SELF-TEST FALLIDO al arrancar*\n\n${failList}${warnList}\n\n⚙️ MIIA sigue operativa pero con degradación.`
      );
    } catch (e) {
      console.error(`[SELF-TEST] Error notificando al owner: ${e.message}`);
    }
  }

  // Warnings sin fallos: solo loguear en consola, NO molestar al owner por WhatsApp
  // El owner no necesita saber que el cerebro está vacío cada vez que Railway redeploya
  if (fails.length === 0 && warns.length > 0) {
    console.log(`[SELF-TEST] 🟡 ${warns.length} warnings (solo log, no se notifica al owner por WhatsApp)`);
  }

  return { passed, results: [...results], summary };
}

module.exports = { runSelfTest };
