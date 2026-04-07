// ════════════════════════════════════════════════════════════════════════════
// MIIA — Businesses & Contact Groups Routes
// ════════════════════════════════════════════════════════════════════════════
// Endpoints CRUD para negocios multi-tenant y grupos de contacto dinámicos.
// Montado en server.js como: app.use('/api/tenant/:uid', businessesRouter);
// ════════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams para acceder a :uid
const admin = require('firebase-admin');

// Lazy init — admin.firestore() no disponible hasta que server.js llame initializeApp()
let _db;
function db() { if (!_db) _db = admin.firestore(); return _db; }

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function userRef(uid) { return db().collection('users').doc(uid); }
function bizCol(uid) { return userRef(uid).collection('businesses'); }
function bizRef(uid, bizId) { return bizCol(uid).doc(bizId); }
function groupCol(uid) { return userRef(uid).collection('contact_groups'); }
function groupRef(uid, gid) { return groupCol(uid).doc(gid); }
function contactIndexRef(uid, phone) { return userRef(uid).collection('contact_index').doc(phone); }

// ════════════════════════════════════════════════════════════════════════════
// BUSINESSES CRUD
// ════════════════════════════════════════════════════════════════════════════

// GET /api/tenant/:uid/businesses — lista todos los negocios
router.get('/businesses', async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await bizCol(uid).orderBy('createdAt', 'desc').get();
    const businesses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(businesses);
  } catch (e) {
    console.error(`[BIZ] Error listing businesses for ${req.params.uid}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tenant/:uid/businesses — crear negocio
router.post('/businesses', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, email, address, website, demoLink, description, whatsapp_number, ownerRole } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name requerido' });

    const bizData = {
      name: name.trim(),
      email: (email || '').trim(),
      address: (address || '').trim(),
      website: (website || '').trim(),
      demoLink: (demoLink || '').trim(),
      description: (description || '').trim(),
      whatsapp_number: (whatsapp_number || '').trim(),
      ownerRole: (ownerRole || '').trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const docRef = await bizCol(uid).add(bizData);

    // Si es el primer negocio, setear como default
    const allBiz = await bizCol(uid).get();
    if (allBiz.size === 1) {
      await userRef(uid).set({ defaultBusinessId: docRef.id }, { merge: true });
    }

    console.log(`[BIZ] Negocio creado: ${bizData.name} (${docRef.id}) para uid=${uid}`);
    res.json({ success: true, id: docRef.id, business: { id: docRef.id, ...bizData } });
  } catch (e) {
    console.error(`[BIZ] Error creating business for ${req.params.uid}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tenant/:uid/businesses/:bizId — detalle de un negocio
router.get('/businesses/:bizId', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const doc = await bizRef(uid, bizId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/tenant/:uid/businesses/:bizId — actualizar negocio
router.put('/businesses/:bizId', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { name, email, address, website, demoLink, description, whatsapp_number, ownerRole } = req.body;

    const updates = { updatedAt: new Date().toISOString() };
    if (name !== undefined) updates.name = name.trim();
    if (email !== undefined) updates.email = email.trim();
    if (address !== undefined) updates.address = address.trim();
    if (website !== undefined) updates.website = website.trim();
    if (demoLink !== undefined) updates.demoLink = demoLink.trim();
    if (description !== undefined) updates.description = description.trim();
    if (whatsapp_number !== undefined) updates.whatsapp_number = whatsapp_number.trim();
    if (ownerRole !== undefined) updates.ownerRole = ownerRole.trim();

    await bizRef(uid, bizId).update(updates);
    console.log(`[BIZ] Negocio actualizado: ${bizId} para uid=${uid}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tenant/:uid/businesses/:bizId — eliminar negocio
router.delete('/businesses/:bizId', async (req, res) => {
  try {
    const { uid, bizId } = req.params;

    // No permitir eliminar si es el único negocio
    const allBiz = await bizCol(uid).get();
    if (allBiz.size <= 1) return res.status(400).json({ error: 'No puedes eliminar tu único negocio' });

    // Eliminar subcollections
    const subcols = ['products', 'sessions'];
    for (const sub of subcols) {
      const snap = await bizRef(uid, bizId).collection(sub).get();
      const batch = db().batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      if (snap.size > 0) await batch.commit();
    }
    // Eliminar docs individuales (brain, contact_rules, payment_methods)
    const singleDocs = ['brain/business_cerebro', 'contact_rules', 'payment_methods'];
    for (const path of singleDocs) {
      try { await bizRef(uid, bizId).collection('brain').doc('business_cerebro').delete(); } catch (_) {}
    }

    await bizRef(uid, bizId).delete();

    // Si era el default, asignar otro
    const userDoc = await userRef(uid).get();
    if (userDoc.exists && userDoc.data().defaultBusinessId === bizId) {
      const remaining = await bizCol(uid).limit(1).get();
      if (!remaining.empty) {
        await userRef(uid).update({ defaultBusinessId: remaining.docs[0].id });
      }
    }

    console.log(`[BIZ] Negocio eliminado: ${bizId} para uid=${uid}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// BUSINESS SUB-RESOURCES (products, brain, contact-rules, payment-methods, sessions)
// ════════════════════════════════════════════════════════════════════════════

// ── Products ──────────────────────────────────────────────────────────────

router.get('/businesses/:bizId/products', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const snap = await bizRef(uid, bizId).collection('products').orderBy('createdAt', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/businesses/:bizId/products', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { name, description, price, pricePromo, stock, extras } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name requerido' });

    const productData = {
      name: name.trim(),
      description: (description || '').trim(),
      price: price || '',
      pricePromo: pricePromo || '',
      stock: stock || '',
      extras: extras || {},
      createdAt: new Date().toISOString()
    };

    const docRef = await bizRef(uid, bizId).collection('products').add(productData);
    console.log(`[BIZ] Producto creado: ${productData.name} en biz=${bizId}`);
    res.json({ success: true, id: docRef.id, product: productData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/businesses/:bizId/products/:productId', express.json(), async (req, res) => {
  try {
    const { uid, bizId, productId } = req.params;
    const updates = { ...req.body, updatedAt: new Date().toISOString() };
    delete updates.id; // no guardar el id como campo
    await bizRef(uid, bizId).collection('products').doc(productId).update(updates);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/businesses/:bizId/products/:productId', async (req, res) => {
  try {
    const { uid, bizId, productId } = req.params;
    await bizRef(uid, bizId).collection('products').doc(productId).delete();
    console.log(`[BIZ] Producto eliminado: ${productId} de biz=${bizId}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Brain (cerebro del negocio) ───────────────────────────────────────────

router.get('/businesses/:bizId/brain', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const doc = await bizRef(uid, bizId).collection('brain').doc('business_cerebro').get();
    res.json(doc.exists ? doc.data() : { content: '', updatedAt: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/businesses/:bizId/brain', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { content } = req.body;
    await bizRef(uid, bizId).collection('brain').doc('business_cerebro').set({
      content: content || '',
      updatedAt: new Date().toISOString()
    });
    console.log(`[BIZ] Cerebro actualizado para biz=${bizId}`);
    // Invalidar prompt cache para este owner
    try { require('../ai/prompt_cache').invalidateOwner(uid); } catch (_) {}

    // ═══ OPUS CEREBRO: Regenerar artefactos premium en background ═══
    // Opus piensa 1 vez (~$0.03) → Flash ejecuta 1000 veces gratis
    (async () => {
      try {
        const opusCerebro = require('../ai/opus_cerebro');
        // Cargar datos completos del negocio
        const bizDoc = await bizRef(uid, bizId).get();
        const bizData = bizDoc.exists ? { ...bizDoc.data(), cerebro: content || '' } : { cerebro: content || '' };
        // Cargar productos
        const prodSnap = await bizRef(uid, bizId).collection('products').get();
        bizData.products = prodSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Cargar contact rules y payment methods
        try {
          const crDoc = await bizRef(uid, bizId).collection('config').doc('contact_rules').get();
          if (crDoc.exists) bizData.contactRules = crDoc.data();
        } catch (_) {}
        try {
          const pmDoc = await bizRef(uid, bizId).collection('config').doc('payment_methods').get();
          if (pmDoc.exists) bizData.paymentMethods = pmDoc.data();
        } catch (_) {}
        // Cargar owner profile
        const userDoc = await userRef(uid).get();
        const ownerProfile = userDoc.exists ? userDoc.data() : {};
        const ownerConfig = { aiProvider: ownerProfile.aiProvider, aiApiKey: ownerProfile.aiApiKey };

        // Generar cerebro premium (o fallback si Opus falla)
        const premiumCerebro = await opusCerebro.generateOrFallback(uid, bizData, ownerProfile, ownerConfig);

        // Guardar en Firestore
        await bizRef(uid, bizId).collection('brain').doc('opus_cerebro').set({
          ...premiumCerebro,
          updatedAt: new Date().toISOString()
        });
        console.log(`[BIZ] 🧠 Opus Cerebro guardado para biz=${bizId} (fallback: ${premiumCerebro._meta?.isFallback || false})`);
      } catch (err) {
        console.error(`[BIZ] ⚠️ Error generando Opus Cerebro para biz=${bizId}: ${err.message}`);
        // No falla el request — el cerebro crudo ya se guardó
      }
    })();

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Opus Cerebro (cerebro premium generado por Opus) ─────────────────────

router.get('/businesses/:bizId/opus-cerebro', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const doc = await bizRef(uid, bizId).collection('brain').doc('opus_cerebro').get();
    if (!doc.exists) return res.json({ exists: false, message: 'Opus Cerebro no generado aún. Guarda el cerebro del negocio para generarlo.' });
    res.json({ exists: true, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/businesses/:bizId/regenerate-cerebro', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const opusCerebro = require('../ai/opus_cerebro');

    // Cargar todo
    const bizDoc = await bizRef(uid, bizId).get();
    if (!bizDoc.exists) return res.status(404).json({ error: 'Negocio no encontrado' });
    const bizData = { ...bizDoc.data() };

    const brainDoc = await bizRef(uid, bizId).collection('brain').doc('business_cerebro').get();
    bizData.cerebro = brainDoc.exists ? brainDoc.data().content : '';

    const prodSnap = await bizRef(uid, bizId).collection('products').get();
    bizData.products = prodSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    try {
      const crDoc = await bizRef(uid, bizId).collection('config').doc('contact_rules').get();
      if (crDoc.exists) bizData.contactRules = crDoc.data();
    } catch (_) {}
    try {
      const pmDoc = await bizRef(uid, bizId).collection('config').doc('payment_methods').get();
      if (pmDoc.exists) bizData.paymentMethods = pmDoc.data();
    } catch (_) {}

    const userDoc = await userRef(uid).get();
    const ownerProfile = userDoc.exists ? userDoc.data() : {};
    const ownerConfig = { aiProvider: ownerProfile.aiProvider, aiApiKey: ownerProfile.aiApiKey };

    console.log(`[BIZ] 🧠 Regeneración manual de Opus Cerebro para biz=${bizId}`);
    const premiumCerebro = await opusCerebro.generateOrFallback(uid, bizData, ownerProfile, ownerConfig);

    await bizRef(uid, bizId).collection('brain').doc('opus_cerebro').set({
      ...premiumCerebro,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      isFallback: premiumCerebro._meta?.isFallback || false,
      generatedBy: premiumCerebro._meta?.generatedBy || 'unknown',
      estimatedCost: premiumCerebro._meta?.estimatedCost || '$0'
    });
  } catch (e) {
    console.error(`[BIZ] Error regenerando Opus Cerebro:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Contact Rules ─────────────────────────────────────────────────────────

router.get('/businesses/:bizId/contact-rules', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const doc = await bizRef(uid, bizId).collection('config').doc('contact_rules').get();
    res.json(doc.exists ? doc.data() : { lead_keywords: [], client_keywords: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/businesses/:bizId/contact-rules', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { lead_keywords, client_keywords } = req.body;
    const { validateKeyword } = require('../core/contact_gate');
    const allKws = [...(lead_keywords || []), ...(client_keywords || [])];
    const invalid = allKws.map(kw => ({ kw, ...validateKeyword(kw) })).filter(r => !r.valid);
    if (invalid.length > 0) {
      return res.status(400).json({ error: 'Keywords inválidas', details: invalid.map(i => ({ keyword: i.kw, reason: i.reason })) });
    }
    const rulesData = {
      lead_keywords: lead_keywords || [],
      client_keywords: client_keywords || [],
      updatedAt: new Date().toISOString()
    };
    await bizRef(uid, bizId).collection('config').doc('contact_rules').set(rulesData, { merge: true });
    res.json({ success: true, rules: rulesData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Payment Methods ───────────────────────────────────────────────────────

router.get('/businesses/:bizId/payment-methods', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const doc = await bizRef(uid, bizId).collection('config').doc('payment_methods').get();
    res.json(doc.exists ? (doc.data().methods || []) : []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/businesses/:bizId/payment-methods', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { methods } = req.body;
    if (!Array.isArray(methods)) return res.status(400).json({ error: 'methods array required' });

    await bizRef(uid, bizId).collection('config').doc('payment_methods').set({
      methods,
      updatedAt: new Date().toISOString()
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sessions (chat experto) ───────────────────────────────────────────────

router.get('/businesses/:bizId/sessions', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const snap = await bizRef(uid, bizId).collection('sessions').orderBy('createdAt', 'desc').get();
    res.json(snap.docs.map(d => ({ date: d.id, ...d.data() })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/businesses/:bizId/sessions', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { messages, trainingBlock } = req.body;
    if (!messages || !trainingBlock) return res.status(400).json({ error: 'messages and trainingBlock required' });

    const dateKey = new Date().toISOString().split('T')[0];

    const sessionData = {
      messages,
      trainingBlock,
      summary: dateKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await bizRef(uid, bizId).collection('sessions').doc(dateKey).set(sessionData);
    console.log(`[BIZ] Sesión guardada: ${dateKey} en biz=${bizId}`);
    res.json({ success: true, date: dateKey, summary: sessionData.summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/businesses/:bizId/sessions/:date', express.json(), async (req, res) => {
  try {
    const { uid, bizId, date } = req.params;
    const { additionalText } = req.body;
    if (!additionalText) return res.status(400).json({ error: 'additionalText required' });

    const docRef = bizRef(uid, bizId).collection('sessions').doc(date);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Session not found' });

    const existing = doc.data();
    await docRef.update({
      trainingBlock: existing.trainingBlock + '\n' + additionalText,
      updatedAt: new Date().toISOString()
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/businesses/:bizId/sessions/:date', async (req, res) => {
  try {
    const { uid, bizId, date } = req.params;
    await bizRef(uid, bizId).collection('sessions').doc(date).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CONTACT GROUPS CRUD
// ════════════════════════════════════════════════════════════════════════════

// GET /api/tenant/:uid/contact-groups
router.get('/contact-groups', async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await groupCol(uid).orderBy('createdAt', 'asc').get();
    const groups = [];
    for (const doc of snap.docs) {
      const data = { id: doc.id, ...doc.data() };
      // Contar contactos
      const contactsSnap = await groupRef(uid, doc.id).collection('contacts').get();
      data.contactCount = contactsSnap.size;
      groups.push(data);
    }
    res.json(groups);
  } catch (e) {
    console.error(`[GROUPS] Error listing groups for ${req.params.uid}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tenant/:uid/contact-groups
router.post('/contact-groups', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, icon, tone, autoRespond, proactiveEnabled } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name requerido' });

    const groupData = {
      name: name.trim(),
      icon: icon || '👥',
      tone: (tone || '').trim(),
      autoRespond: autoRespond === true ? true : false,
      proactiveEnabled: proactiveEnabled === true ? true : false,
      createdAt: new Date().toISOString()
    };

    const docRef = await groupCol(uid).add(groupData);
    console.log(`[GROUPS] Grupo creado: ${groupData.name} (${docRef.id}) para uid=${uid}`);
    res.json({ success: true, id: docRef.id, group: { id: docRef.id, ...groupData, contactCount: 0 } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/tenant/:uid/contact-groups/:groupId
router.put('/contact-groups/:groupId', express.json(), async (req, res) => {
  try {
    const { uid, groupId } = req.params;
    const { name, icon, tone, autoRespond, proactiveEnabled } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (icon !== undefined) updates.icon = icon;
    if (tone !== undefined) updates.tone = tone.trim();
    if (autoRespond !== undefined) updates.autoRespond = autoRespond === true;
    if (proactiveEnabled !== undefined) updates.proactiveEnabled = proactiveEnabled === true;
    updates.updatedAt = new Date().toISOString();

    await groupRef(uid, groupId).update(updates);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tenant/:uid/contact-groups/:groupId
router.delete('/contact-groups/:groupId', async (req, res) => {
  try {
    const { uid, groupId } = req.params;

    // Eliminar contactos del grupo
    const contactsSnap = await groupRef(uid, groupId).collection('contacts').get();
    if (contactsSnap.size > 0) {
      const batch = db().batch();
      contactsSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();

      // Limpiar contact_index para estos contactos
      const indexBatch = db().batch();
      for (const d of contactsSnap.docs) {
        indexBatch.delete(contactIndexRef(uid, d.id));
      }
      await indexBatch.commit();
    }

    await groupRef(uid, groupId).delete();
    console.log(`[GROUPS] Grupo eliminado: ${groupId} para uid=${uid}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Contacts within a group ───────────────────────────────────────────────

// GET /api/tenant/:uid/contact-groups/:groupId/contacts
router.get('/contact-groups/:groupId/contacts', async (req, res) => {
  try {
    const { uid, groupId } = req.params;
    const snap = await groupRef(uid, groupId).collection('contacts').orderBy('addedAt', 'desc').get();
    res.json(snap.docs.map(d => ({ phone: d.id, ...d.data() })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tenant/:uid/contact-groups/:groupId/contacts
router.post('/contact-groups/:groupId/contacts', express.json(), async (req, res) => {
  try {
    const { uid, groupId } = req.params;
    const { phone, name, notes, proactiveEnabled } = req.body;
    if (!phone || !phone.trim()) return res.status(400).json({ error: 'phone requerido' });

    const cleanPhone = phone.replace(/\D/g, '');
    const contactData = {
      name: (name || '').trim(),
      notes: (notes || '').trim(),
      proactiveEnabled: proactiveEnabled === true ? true : false,
      addedAt: new Date().toISOString()
    };

    await groupRef(uid, groupId).collection('contacts').doc(cleanPhone).set(contactData);

    // Actualizar contact_index
    const groupDoc = await groupRef(uid, groupId).get();
    const groupName = groupDoc.exists ? groupDoc.data().name : '';
    await contactIndexRef(uid, cleanPhone).set({
      type: 'group',
      groupId,
      groupName,
      name: contactData.name,
      updatedAt: new Date().toISOString()
    });

    console.log(`[GROUPS] Contacto ${cleanPhone} agregado a grupo ${groupId}`);
    res.json({ success: true, contact: { phone: cleanPhone, ...contactData } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/tenant/:uid/contact-groups/:groupId/contacts/:phone
router.put('/contact-groups/:groupId/contacts/:phone', express.json(), async (req, res) => {
  try {
    const { uid, groupId, phone } = req.params;
    const { name, notes, proactiveEnabled } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (notes !== undefined) updates.notes = notes.trim();
    if (proactiveEnabled !== undefined) updates.proactiveEnabled = proactiveEnabled === true;

    await groupRef(uid, groupId).collection('contacts').doc(phone).update(updates);

    // Actualizar nombre en contact_index si cambió
    if (name !== undefined) {
      await contactIndexRef(uid, phone).update({ name: name.trim(), updatedAt: new Date().toISOString() });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tenant/:uid/contact-groups/:groupId/contacts/:phone
router.delete('/contact-groups/:groupId/contacts/:phone', async (req, res) => {
  try {
    const { uid, groupId, phone } = req.params;
    await groupRef(uid, groupId).collection('contacts').doc(phone).delete();
    await contactIndexRef(uid, phone).delete();
    console.log(`[GROUPS] Contacto ${phone} eliminado de grupo ${groupId}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tenant/:uid/contact-groups/move-contact — mover contacto entre grupos
router.post('/contact-groups/move-contact', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { phone, fromGroupId, toGroupId } = req.body;
    if (!phone || !fromGroupId || !toGroupId) return res.status(400).json({ error: 'phone, fromGroupId, toGroupId requeridos' });

    // Leer contacto del grupo origen
    const contactDoc = await groupRef(uid, fromGroupId).collection('contacts').doc(phone).get();
    if (!contactDoc.exists) return res.status(404).json({ error: 'Contacto no encontrado en grupo origen' });

    const contactData = contactDoc.data();

    // Mover: crear en destino, eliminar de origen
    await groupRef(uid, toGroupId).collection('contacts').doc(phone).set(contactData);
    await groupRef(uid, fromGroupId).collection('contacts').doc(phone).delete();

    // Actualizar contact_index
    const toGroupDoc = await groupRef(uid, toGroupId).get();
    await contactIndexRef(uid, phone).update({
      groupId: toGroupId,
      groupName: toGroupDoc.exists ? toGroupDoc.data().name : '',
      updatedAt: new Date().toISOString()
    });

    console.log(`[GROUPS] Contacto ${phone} movido de ${fromGroupId} a ${toGroupId}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CONTACT INDEX
// ════════════════════════════════════════════════════════════════════════════

// GET /api/tenant/:uid/contact-index/:phone
router.get('/contact-index/:phone', async (req, res) => {
  try {
    const { uid, phone } = req.params;
    const doc = await contactIndexRef(uid, phone).get();
    if (!doc.exists) return res.json({ found: false });
    res.json({ found: true, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tenant/:uid/contact-index/:phone — crear/actualizar entrada en index
router.post('/contact-index/:phone', express.json(), async (req, res) => {
  try {
    const { uid, phone } = req.params;
    const { type, groupId, businessId, name, groupName } = req.body;

    const indexData = {
      type: type || 'pending',
      name: (name || '').trim(),
      updatedAt: new Date().toISOString()
    };
    if (groupId) indexData.groupId = groupId;
    if (groupName) indexData.groupName = groupName;
    if (businessId) indexData.businessId = businessId;

    await contactIndexRef(uid, phone).set(indexData, { merge: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DEFAULT BUSINESS HELPER
// ════════════════════════════════════════════════════════════════════════════

// GET /api/tenant/:uid/default-business — obtener el negocio default
router.get('/default-business', async (req, res) => {
  try {
    const { uid } = req.params;
    const userDoc = await userRef(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const { defaultBusinessId } = userDoc.data();
    if (!defaultBusinessId) {
      // Auto-detect: si hay exactamente 1 negocio, usarlo
      const bizSnap = await bizCol(uid).limit(2).get();
      if (bizSnap.size === 1) {
        const bizId = bizSnap.docs[0].id;
        await userRef(uid).update({ defaultBusinessId: bizId });
        return res.json({ id: bizId, ...bizSnap.docs[0].data() });
      }
      return res.json({ id: null });
    }

    const bizDoc = await bizRef(uid, defaultBusinessId).get();
    if (!bizDoc.exists) return res.json({ id: null });
    res.json({ id: bizDoc.id, ...bizDoc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/tenant/:uid/default-business — cambiar negocio default
router.put('/default-business', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { businessId } = req.body;
    if (!businessId) return res.status(400).json({ error: 'businessId requerido' });

    await userRef(uid).update({ defaultBusinessId: businessId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
