'use strict';

/**
 * COTIZACIONES ROUTER — Propuestas interactivas para leads
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, zero silent failures)
 *
 * Endpoints:
 *   POST /api/cotizacion/generate       — Backend interno genera hash (auth: MIIA_INTERNAL_TOKEN)
 *   GET  /api/cotizacion/:hash          — Lead abre propuesta (público, rateado)
 *   POST /api/cotizacion/:hash/event    — Tracking: viewed/adjusted/downloaded (público, rateado)
 *   GET  /api/cotizacion/config/:uid    — Owner lee su config (auth: Firebase token)
 *   PUT  /api/cotizacion/config/:uid    — Owner guarda su config (auth: Firebase token)
 *   GET  /api/cotizacion/list/:uid      — Owner lista sus cotizaciones (auth: Firebase token)
 */

const express = require('express');
const crypto  = require('crypto');

// ═══════════════════════════════════════════════════════════════
// RATE LIMIT EN MEMORIA (sin dependencia externa)
// ═══════════════════════════════════════════════════════════════
const rateLimits = new Map();

function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const ip  = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const rec = rateLimits.get(ip);
    if (!rec || now > rec.resetAt) {
      rateLimits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (rec.count >= maxReq) {
      console.warn(`[COTIZACION] ⚠️ Rate limit hit: ${ip} (${rec.count}/${maxReq})`);
      return res.status(429).json({ error: 'Too many requests' });
    }
    rec.count++;
    next();
  };
}

// Limpiar entradas viejas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateLimits) {
    if (now > rec.resetAt) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// DEFAULTS DE BRANDING (Medilink desde el día 1)
// ═══════════════════════════════════════════════════════════════
const DEFAULTS = {
  branding: {
    logo_url:        null,
    primary_color:   '#00AEEF',
    secondary_color: '#0B3C5A',
    accent_color:    '#00B388',
    font_body:       'Poppins',
    font_heading:    'Poppins',
    hero_gradient:   '135deg, #0B3C5A 0%, #0D6B99 55%, #00AEEF 100%',
    hero_image_url:  null,
    favicon_url:     null,
  },
  content: {
    company_name:    'Medilink',
    tagline:         'Especialistas en salud, igual que tú',
    website_url:     'https://softwaremedilink.com',
    whatsapp_number: null,
    email:           null,
    welcome_message: null,
    cta_text:        'Quiero comenzar',
    cta_url:         'https://softwaremedilink.com',
    footer_text:     null,
    social:          {},
  },
  product: {
    product_name:      'Medilink',
    plan_names:        { esencial: 'Esencial', pro: 'Pro', titanium: 'Titanium' },
    default_country:   'CO',
    currency_override: null,
    pricing_margin:    0,
    show_pricing:      true,
    modules_enabled:   ['wa', 'firma', 'factura'],
  },
  sections: {
    show_promise:   true,
    show_plans:     true,
    show_users:     true,
    show_modules:   true,
    show_normativa: true,
    show_features:  true,
    show_stats:     true,
    show_awards:    true,
  },
  notifications: {
    notify_on_view:     true,
    notify_on_adjust:   true,
    notify_on_download: true,
    notify_channel:     'whatsapp',
    notify_number:      null,
  },
};

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function deepMerge(defaults, overrides) {
  if (!overrides) return { ...defaults };
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] && typeof overrides[key] === 'object'
        && !Array.isArray(overrides[key])) {
      result[key] = deepMerge(defaults[key] || {}, overrides[key]);
    } else if (overrides[key] !== undefined) {
      result[key] = overrides[key];
    }
  }
  return result;
}

function generateHash() {
  return crypto.randomBytes(4).toString('hex'); // 8 chars hex
}

// ═══════════════════════════════════════════════════════════════
// ROUTER FACTORY
// ═══════════════════════════════════════════════════════════════

module.exports = function createCotizacionRoutes({ db, verifyToken }) {
  const router = express.Router();

  // ──────────────────────────────────────────────────────
  // POST /api/cotizacion/generate
  // Auth: Bearer MIIA_INTERNAL_TOKEN (solo backend interno)
  // ──────────────────────────────────────────────────────
  router.post('/generate', async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (token !== process.env.MIIA_INTERNAL_TOKEN) {
      console.warn('[COTIZACION] ❌ generate: token inválido');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenant_id, lead_name, lead_phone,
            params, expires_days = 30 } = req.body;

    if (!tenant_id || !lead_phone || !params) {
      return res.status(400).json({ error: 'Missing required fields: tenant_id, lead_phone, params' });
    }

    try {
      // Generar hash único con verificación de colisión
      let hash, exists = true, attempts = 0;
      while (exists && attempts < 5) {
        hash    = generateHash();
        const doc = await db.collection('cotizaciones').doc(hash).get();
        exists  = doc.exists;
        attempts++;
      }
      if (exists) throw new Error('Hash collision after 5 attempts — retry');

      const now       = new Date();
      const expiresAt = new Date(now.getTime() + expires_days * 24 * 60 * 60 * 1000);

      await db.collection('cotizaciones').doc(hash).set({
        tenant_id,
        lead_name:  lead_name || null,
        lead_phone,
        hash,
        params,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        events:     [{ type: 'created', at: now.toISOString(), source: 'miia' }],
        status:     'pending',
        notified:   { viewed: false, adjusted: false, downloaded: false },
      });

      const base = process.env.COTIZACION_BASE_URL || 'https://miia-app.com';
      const url  = `${base}/p/${hash}`;

      console.log(`[COTIZACION] ✅ Generada: ${hash} para ${lead_name || lead_phone} (tenant: ${tenant_id}) → ${url}`);

      return res.json({ hash, url, expires_at: expiresAt.toISOString() });
    } catch (e) {
      console.error(`[COTIZACION] ❌ generate error: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────
  // GET /api/cotizacion/:hash
  // Pública — rateada — el browser del lead la llama
  // ──────────────────────────────────────────────────────
  router.get('/:hash([a-f0-9]{8})',
    rateLimit(60, 60 * 1000),
    async (req, res) => {
      // CORS: permitir desde miia-app.com
      const allowedOrigin = process.env.COTIZACION_BASE_URL || 'https://miia-app.com';
      res.header('Access-Control-Allow-Origin', allowedOrigin);

      const { hash } = req.params;
      try {
        const doc = await db.collection('cotizaciones').doc(hash).get();
        if (!doc.exists) {
          return res.status(404).json({ error: 'Not found' });
        }

        const data    = doc.data();
        const expired = new Date(data.expires_at) < new Date();
        if (expired) {
          return res.json({ expired: true });
        }

        // Cargar config del tenant (merge con defaults)
        let tenantConfig = DEFAULTS;
        try {
          const cfgDoc = await db.collection('tenants')
            .doc(data.tenant_id)
            .collection('config')
            .doc('cotizacion_config').get();
          if (cfgDoc.exists) {
            tenantConfig = deepMerge(DEFAULTS, cfgDoc.data());
          }
        } catch (_) { /* usar defaults silenciosamente */ }

        const margin = tenantConfig.product.pricing_margin || 0;

        return res.json({
          params:         data.params,
          tenant_config:  tenantConfig,
          lead_name:      data.lead_name,
          expires_at:     data.expires_at,
          expired:        false,
          pricing_factor: 1 + (margin / 100),
        });
      } catch (e) {
        console.error(`[COTIZACION] ❌ GET ${hash}: ${e.message}`);
        return res.status(500).json({ error: e.message });
      }
    }
  );

  // ──────────────────────────────────────────────────────
  // POST /api/cotizacion/:hash/event
  // Pública — rateada — tracking del lead
  // ──────────────────────────────────────────────────────
  router.post('/:hash([a-f0-9]{8})/event',
    rateLimit(30, 60 * 1000),
    async (req, res) => {
      const { hash }                = req.params;
      const { type, changes, device } = req.body;
      const validTypes = ['viewed', 'adjusted', 'downloaded'];

      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: 'Invalid event type' });
      }

      try {
        const ref = db.collection('cotizaciones').doc(hash);
        const doc = await ref.get();
        if (!doc.exists) return res.json({ ok: true }); // silencioso

        const data = doc.data();
        if (new Date(data.expires_at) < new Date()) {
          return res.json({ ok: true }); // expirado, ignorar
        }

        const event = {
          type,
          at: new Date().toISOString(),
          ...(device  && { device }),
          ...(changes && { changes }),
        };

        const statusMap = {
          viewed:     'viewed',
          adjusted:   'adjusted',
          downloaded: 'downloaded',
        };

        await ref.update({
          events: [...(data.events || []), event],
          status: statusMap[type] || data.status,
        });

        // Notificar al owner (async, no bloquear respuesta)
        if (!data.notified[type]) {
          setImmediate(() =>
            sendOwnerNotification(db, hash, type, data, changes)
              .catch(e => console.error(`[COTIZACION] ❌ notif error: ${e.message}`))
          );
        }

        console.log(`[COTIZACION] 📊 Event: ${type} on ${hash} (lead: ${data.lead_name || data.lead_phone})`);
        return res.json({ ok: true });
      } catch (e) {
        console.error(`[COTIZACION] ❌ event error: ${e.message}`);
        return res.status(500).json({ error: e.message });
      }
    }
  );

  // ──────────────────────────────────────────────────────
  // GET /api/cotizacion/config/:uid
  // Auth: Firebase ID Token del owner
  // ──────────────────────────────────────────────────────
  router.get('/config/:uid', verifyToken, async (req, res) => {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const doc = await db.collection('tenants')
        .doc(req.params.uid)
        .collection('config')
        .doc('cotizacion_config').get();

      return res.json(doc.exists ? deepMerge(DEFAULTS, doc.data()) : DEFAULTS);
    } catch (e) {
      console.error(`[COTIZACION] ❌ config GET: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────
  // PUT /api/cotizacion/config/:uid
  // Auth: Firebase ID Token del owner
  // ──────────────────────────────────────────────────────
  router.put('/config/:uid', verifyToken, async (req, res) => {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const ref = db.collection('tenants')
        .doc(req.params.uid)
        .collection('config')
        .doc('cotizacion_config');

      await ref.set({
        ...req.body,
        updated_at: new Date().toISOString(),
      }, { merge: true });

      console.log(`[COTIZACION] ✅ Config actualizada para tenant ${req.params.uid}`);
      return res.json({ ok: true });
    } catch (e) {
      console.error(`[COTIZACION] ❌ config PUT: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────
  // GET /api/cotizacion/list/:uid
  // Auth: Firebase ID Token del owner
  // ──────────────────────────────────────────────────────
  router.get('/list/:uid', verifyToken, async (req, res) => {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { status, limit = 20 } = req.query;
    try {
      let q = db.collection('cotizaciones')
        .where('tenant_id', '==', req.params.uid)
        .orderBy('created_at', 'desc')
        .limit(Number(limit));

      if (status) q = q.where('status', '==', status);

      const snap = await q.get();
      const base = process.env.COTIZACION_BASE_URL || 'https://miia-app.com';

      return res.json(snap.docs.map(d => {
        const data      = d.data();
        const lastEvent = data.events?.[data.events.length - 1] || null;
        return {
          hash:       data.hash,
          lead_name:  data.lead_name,
          lead_phone: data.lead_phone,
          params:     data.params,
          status:     data.status,
          created_at: data.created_at,
          expires_at: data.expires_at,
          last_event: lastEvent,
          url:        `${base}/p/${data.hash}`,
        };
      }));
    } catch (e) {
      console.error(`[COTIZACION] ❌ list error: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

// ═══════════════════════════════════════════════════════════════
// HELPER: Notificación WhatsApp al owner
// ═══════════════════════════════════════════════════════════════

async function sendOwnerNotification(db, hash, type, data, changes) {
  try {
    // Cargar config del tenant para saber a quién notificar
    let cfg = {};
    try {
      const cfgDoc = await db.collection('tenants')
        .doc(data.tenant_id)
        .collection('config')
        .doc('cotizacion_config').get();
      if (cfgDoc.exists) cfg = cfgDoc.data();
    } catch (_) {}

    const notifCfg    = cfg.notifications || {};
    const shouldNotify = notifCfg[`notify_on_${type}`] !== false;
    if (!shouldNotify) return;

    // Número a notificar: config > tenant doc > skip
    const tenantDoc   = await db.collection('tenants').doc(data.tenant_id).get();
    const tenantPhone = notifCfg.notify_number
      || tenantDoc.data()?.phone
      || null;
    if (!tenantPhone) return;

    const lead  = data.lead_name || data.lead_phone;
    const plan  = data.params?.plan?.toUpperCase() || '—';
    const users = data.params?.users || '—';
    const modal = data.params?.modalidad || '—';
    const base  = process.env.COTIZACION_BASE_URL || 'https://miia-app.com';
    const url   = `${base}/p/${hash}`;

    const msgs = {
      viewed:     `👁️ *${lead}* acaba de abrir tu propuesta.\nPlan *${plan}* · ${users} usuario(s) · ${modal}\n_${url}_`,
      adjusted:   `✏️ *${lead}* ajustó su propuesta.\n*Cambios:* ${JSON.stringify(changes || {})}\n_Señal de interés activo 🔥_\n_${url}_`,
      downloaded: `📥 *${lead}* descargó su propuesta.\n*Señal de compra. Contactarlo ahora.*\n_${url}_`,
    };

    const msg = msgs[type];
    if (!msg) return;

    // Llamar al sistema de mensajería interno de MIIA
    const railwayUrl = process.env.RAILWAY_INTERNAL_URL || 'http://localhost:3000';
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10000);

    await fetch(`${railwayUrl}/api/send-message`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.MIIA_INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({
        tenantId: data.tenant_id,
        phone:    tenantPhone,
        message:  msg,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Marcar como notificado
    await db.collection('cotizaciones').doc(hash).update({
      [`notified.${type}`]: true,
    });

    console.log(`[COTIZACION] 📨 Notificación ${type} enviada al owner (${tenantPhone})`);
  } catch (e) {
    console.error(`[COTIZACION] ❌ sendOwnerNotification: ${e.message}`);
  }
}
