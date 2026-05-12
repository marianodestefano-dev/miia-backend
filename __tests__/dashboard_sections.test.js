'use strict';
/**
 * R17-A — dashboard_sections.test.js
 * 100% branch coverage: getContacts + getBusiness + updateBusiness +
 * getUpcomingEvents + getConversations + getLearningStatus + getPlan + HTTP routes
 */

const express = require('express');
const request = require('supertest');

// ── Firestore mock ────────────────────────────────────────────────────────────
let mockOwnerExists = false;
let mockOwnerData = {};
let mockOwnerGetThrows = false;
let mockOwnerSetThrows = false;
let mockContacts = [];
let mockContactsGetThrows = false;
let mockEvents = [];
let mockEventsGetThrows = false;
let mockConvs = [];
let mockConvsGetThrows = false;
let mockGamExists = false;
let mockGamData = {};
let mockGamGetThrows = false;
let mockTrainingSize = 0;
let mockTrainingGetThrows = false;

function makeChain(getResult) {
  const self = {
    where: () => self,
    orderBy: () => self,
    limit: () => self,
    get: () => getResult(),
  };
  return self;
}

const mockFs = {
  collection: () => ({
    doc: () => ({
      get: () => {
        if (mockOwnerGetThrows) return Promise.reject(new Error('OWNER-FAIL'));
        return Promise.resolve({ exists: mockOwnerExists, data: () => mockOwnerData });
      },
      set: (data) => {
        if (mockOwnerSetThrows) return Promise.reject(new Error('OWNER-SET-FAIL'));
        mockOwnerData = Object.assign({}, mockOwnerData, data);
        return Promise.resolve();
      },
      collection: (sub) => {
        if (sub === 'contacts') {
          return {
            get: () => {
              if (mockContactsGetThrows) return Promise.reject(new Error('CONTACTS-FAIL'));
              return Promise.resolve({ forEach: (fn) => mockContacts.forEach(fn) });
            },
          };
        }
        if (sub === 'calendar_events') {
          return makeChain(() => {
            if (mockEventsGetThrows) return Promise.reject(new Error('EVENTS-FAIL'));
            return Promise.resolve({ forEach: (fn) => mockEvents.forEach(fn) });
          });
        }
        if (sub === 'conversations') {
          return makeChain(() => {
            if (mockConvsGetThrows) return Promise.reject(new Error('CONVS-FAIL'));
            return Promise.resolve({ forEach: (fn) => mockConvs.forEach(fn) });
          });
        }
        if (sub === 'gamification') {
          return {
            doc: () => ({
              get: () => {
                if (mockGamGetThrows) return Promise.reject(new Error('GAM-FAIL'));
                return Promise.resolve({ exists: mockGamExists, data: () => mockGamData });
              },
            }),
          };
        }
        if (sub === 'training_data') {
          return makeChain(() => {
            if (mockTrainingGetThrows) return Promise.reject(new Error('TRAINING-FAIL'));
            return Promise.resolve({ size: mockTrainingSize });
          });
        }
        return makeChain(() => Promise.resolve({ forEach: () => {}, size: 0 }));
      },
    }),
  }),
};

const createRoutes = require('../routes/dashboard_sections');
const {
  getContacts, getBusiness, updateBusiness,
  getUpcomingEvents, getConversations, getLearningStatus,
  getPlan, __setFirestoreForTests,
} = require('../routes/dashboard_sections');
__setFirestoreForTests(mockFs);

function buildApp() {
  const app = express();
  app.use(express.json());
  const router = createRoutes({
    requireAuth: function (req, res, next) { req.user = { uid: 'uid-test' }; next(); },
  });
  app.use('/', router);
  return app;
}

function buildAppNoAuth() {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes({}));
  return app;
}

beforeEach(() => {
  mockOwnerExists = false;
  mockOwnerData = {};
  mockOwnerGetThrows = false;
  mockOwnerSetThrows = false;
  mockContacts = [];
  mockContactsGetThrows = false;
  mockEvents = [];
  mockEventsGetThrows = false;
  mockConvs = [];
  mockConvsGetThrows = false;
  mockGamExists = false;
  mockGamData = {};
  mockGamGetThrows = false;
  mockTrainingSize = 0;
  mockTrainingGetThrows = false;
});

// ── HTTP routes — 401 sin auth ────────────────────────────────────────────────
describe('HTTP routes — 401 sin usuario', () => {
  const routes = [
    ['GET', '/contacts'],
    ['GET', '/business'],
    ['PUT', '/business'],
    ['GET', '/agenda/upcoming'],
    ['GET', '/conversations'],
    ['GET', '/learning/status'],
    ['GET', '/plan'],
  ];
  routes.forEach(function ([method, path]) {
    test(method + ' ' + path + ' => 401', async () => {
      const app = buildAppNoAuth();
      const r = await request(app)[method.toLowerCase()](path);
      expect(r.status).toBe(401);
    });
  });
});

// ── HTTP routes — validación context ─────────────────────────────────────────
describe('GET /conversations — validación context', () => {
  test('context invalido => 400', async () => {
    const r = await request(buildApp()).get('/conversations?context=invalido');
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('context invalido');
  });

  test('context valido => 200', async () => {
    const r = await request(buildApp()).get('/conversations?context=leads');
    expect(r.status).toBe(200);
  });

  test('sin context => 200', async () => {
    const r = await request(buildApp()).get('/conversations');
    expect(r.status).toBe(200);
  });
});

// ── HTTP routes — 200 success paths ──────────────────────────────────────────
describe('HTTP routes — 200 success', () => {
  test('GET /contacts 200', async () => {
    const r = await request(buildApp()).get('/contacts');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('contacts');
    expect(r.body).toHaveProperty('total');
  });

  test('PUT /business 200 con campo valido', async () => {
    const r = await request(buildApp()).put('/business').send({ name: 'Taller' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('GET /agenda/upcoming 200', async () => {
    const r = await request(buildApp()).get('/agenda/upcoming');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('events');
  });

  test('GET /learning/status 200', async () => {
    const r = await request(buildApp()).get('/learning/status');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('pending_approvals');
  });
});

// ── HTTP routes — 500 en error Firestore ─────────────────────────────────────
describe('HTTP routes — 500 en error', () => {
  test('GET /contacts 500 si Firestore falla', async () => {
    mockContactsGetThrows = true;
    const r = await request(buildApp()).get('/contacts');
    expect(r.status).toBe(500);
  });

  test('GET /business 500 si Firestore falla', async () => {
    mockOwnerGetThrows = true;
    const r = await request(buildApp()).get('/business');
    expect(r.status).toBe(500);
  });

  test('PUT /business 400 sin campos validos', async () => {
    const r = await request(buildApp()).put('/business').send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('sin_campos_validos');
  });

  test('PUT /business 500 si Firestore falla', async () => {
    mockOwnerSetThrows = true;
    const r = await request(buildApp()).put('/business').send({ name: 'Biz' });
    expect(r.status).toBe(500);
  });

  test('GET /agenda/upcoming 500 si Firestore falla', async () => {
    mockEventsGetThrows = true;
    const r = await request(buildApp()).get('/agenda/upcoming');
    expect(r.status).toBe(500);
  });

  test('GET /conversations 500 si Firestore falla', async () => {
    mockConvsGetThrows = true;
    const r = await request(buildApp()).get('/conversations');
    expect(r.status).toBe(500);
  });

  test('GET /plan 500 si Firestore falla', async () => {
    mockOwnerGetThrows = true;
    const r = await request(buildApp()).get('/plan');
    expect(r.status).toBe(500);
  });
});

// ── getContacts ───────────────────────────────────────────────────────────────
describe('getContacts', () => {
  function makeDoc(id, data) {
    return { id, data: () => data };
  }

  test('sin contactos retorna []', async () => {
    const r = await getContacts('uid', '');
    expect(r).toHaveLength(0);
  });

  test('retorna lista con avatar y defaults', async () => {
    mockContacts = [makeDoc('5571234', { name: 'Ana', contextType: 'cliente', lastActivity: '2026-05-10' })];
    const r = await getContacts('uid', '');
    expect(r).toHaveLength(1);
    expect(r[0].avatar).toBe('A');
    expect(r[0].contextType).toBe('cliente');
    expect(r[0].lastActivity).toBe('2026-05-10');
  });

  test('contacto sin name usa phone como name y avatar', async () => {
    mockContacts = [makeDoc('5571234', {})];
    const r = await getContacts('uid', '');
    expect(r[0].name).toBe('5571234');
    expect(r[0].avatar).toBe('5');
    expect(r[0].contextType).toBe('lead');
    expect(r[0].lastActivity).toBeNull();
  });

  test('filtra por q (nombre)', async () => {
    mockContacts = [
      makeDoc('111', { name: 'Carlos Lopez' }),
      makeDoc('222', { name: 'Maria Gomez' }),
    ];
    const r = await getContacts('uid', 'maria');
    expect(r).toHaveLength(1);
    expect(r[0].phone).toBe('222');
  });

  test('filtra por q (phone)', async () => {
    mockContacts = [
      makeDoc('5571234', { name: 'Carlos' }),
      makeDoc('5579999', { name: 'Otro' }),
    ];
    const r = await getContacts('uid', '71234');
    expect(r).toHaveLength(1);
    expect(r[0].phone).toBe('5571234');
  });

  test('q vacio no filtra', async () => {
    mockContacts = [makeDoc('111', { name: 'A' }), makeDoc('222', { name: 'B' })];
    const r = await getContacts('uid', '');
    expect(r).toHaveLength(2);
  });
});

// ── getBusiness ───────────────────────────────────────────────────────────────
describe('getBusiness', () => {
  test('owner no existe: retorna defaults', async () => {
    mockOwnerExists = false;
    const r = await getBusiness('uid');
    expect(r.name).toBe('');
    expect(r.phone).toBe('');
    expect(r.timezone).toBe('America/Bogota');
    expect(r.horario).toBeNull();
    expect(r.activa).toBe(true);
    expect(r.sedes).toEqual([]);
  });

  test('owner existe con datos: retorna business_name y sedes', async () => {
    mockOwnerExists = true;
    mockOwnerData = { business_name: 'Mi Taller', phone: '+57300', timezone: 'UTC', horario: '9-18', activa: true, sedes: ['s1'] };
    const r = await getBusiness('uid');
    expect(r.name).toBe('Mi Taller');
    expect(r.sedes).toEqual(['s1']);
    expect(r.horario).toBe('9-18');
  });

  test('owner sin business_name usa name', async () => {
    mockOwnerExists = true;
    mockOwnerData = { name: 'Juan', phone: '' };
    const r = await getBusiness('uid');
    expect(r.name).toBe('Juan');
  });

  test('activa=false => activa false', async () => {
    mockOwnerExists = true;
    mockOwnerData = { activa: false };
    const r = await getBusiness('uid');
    expect(r.activa).toBe(false);
  });

  test('sedes no-array usa []', async () => {
    mockOwnerExists = true;
    mockOwnerData = { sedes: 'no-array' };
    const r = await getBusiness('uid');
    expect(r.sedes).toEqual([]);
  });
});

// ── updateBusiness ────────────────────────────────────────────────────────────
describe('updateBusiness', () => {
  test('sin campos validos lanza sin_campos_validos', async () => {
    await expect(updateBusiness('uid', {})).rejects.toThrow('sin_campos_validos');
  });

  test('solo name: guarda business_name', async () => {
    const r = await updateBusiness('uid', { name: 'Mi Biz' });
    expect(r.ok).toBe(true);
    expect(mockOwnerData.business_name).toBe('Mi Biz');
  });

  test('phone, timezone, horario, sedes: guarda todos', async () => {
    const r = await updateBusiness('uid', { phone: '+57300', timezone: 'UTC', horario: '9-17', sedes: ['s1'] });
    expect(r.ok).toBe(true);
    expect(mockOwnerData.phone).toBe('+57300');
    expect(mockOwnerData.timezone).toBe('UTC');
    expect(mockOwnerData.horario).toBe('9-17');
    expect(mockOwnerData.sedes).toEqual(['s1']);
  });

  test('horario=null (undefined !== undefined = true) guarda null', async () => {
    const r = await updateBusiness('uid', { horario: null });
    expect(r.ok).toBe(true);
    expect(mockOwnerData.horario).toBeNull();
  });

  test('sedes no-array no se guarda (Array.isArray false)', async () => {
    await expect(updateBusiness('uid', { sedes: 'bad' })).rejects.toThrow('sin_campos_validos');
  });

  test('Firestore throws => error propagado', async () => {
    mockOwnerSetThrows = true;
    await expect(updateBusiness('uid', { name: 'X' })).rejects.toThrow('OWNER-SET-FAIL');
  });
});

// ── getUpcomingEvents ─────────────────────────────────────────────────────────
describe('getUpcomingEvents', () => {
  function makeEvent(id, data) {
    return { id, data: () => data };
  }

  test('sin eventos retorna []', async () => {
    const r = await getUpcomingEvents('uid');
    expect(r).toHaveLength(0);
  });

  test('retorna eventos con defaults', async () => {
    const now = Date.now();
    mockEvents = [
      makeEvent('ev1', { title: 'Reunion', startTs: now + 1000, endTs: now + 2000, location: 'Sala', calendarId: 'cal1' }),
    ];
    const r = await getUpcomingEvents('uid');
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('Reunion');
    expect(r[0].location).toBe('Sala');
  });

  test('evento sin title, endTs, location, calendarId usa defaults', async () => {
    const now = Date.now();
    mockEvents = [makeEvent('ev2', { startTs: now + 1000 })];
    const r = await getUpcomingEvents('uid');
    expect(r[0].title).toBe('');
    expect(r[0].endTs).toBeNull();
    expect(r[0].location).toBeNull();
    expect(r[0].calendarId).toBeNull();
  });
});

// ── getConversations ──────────────────────────────────────────────────────────
describe('getConversations', () => {
  function makeConv(id, data) {
    return { id, data: () => data };
  }

  test('sin conversaciones retorna []', async () => {
    const r = await getConversations('uid', {});
    expect(r).toHaveLength(0);
  });

  test('con context no vacio pasa where branch', async () => {
    mockConvs = [makeConv('111', { name: 'Ana', contextType: 'leads', lastMessage: 'Hola', lastMessageTs: 1000, unread: 2 })];
    const r = await getConversations('uid', { context: 'leads' });
    expect(r).toHaveLength(1);
    expect(r[0].unread).toBe(2);
  });

  test('sin context no pasa where', async () => {
    mockConvs = [makeConv('222', { name: 'B' })];
    const r = await getConversations('uid', {});
    expect(r).toHaveLength(1);
  });

  test('limit invalido usa DEFAULT_CONV_LIMIT', async () => {
    const r = await getConversations('uid', { limit: 'abc' });
    expect(r).toHaveLength(0);
  });

  test('limit > MAX_CONV_LIMIT se clampea a 100', async () => {
    const r = await getConversations('uid', { limit: 9999 });
    expect(r).toHaveLength(0);
  });

  test('conversacion sin name usa phone, defaults restantes', async () => {
    mockConvs = [makeConv('333', {})];
    const r = await getConversations('uid', {});
    expect(r[0].name).toBe('333');
    expect(r[0].contextType).toBe('lead');
    expect(r[0].lastMessage).toBe('');
    expect(r[0].lastMessageTs).toBeNull();
    expect(r[0].unread).toBe(0);
  });
});

// ── getLearningStatus ─────────────────────────────────────────────────────────
describe('getLearningStatus', () => {
  test('sin gamification ni training: retorna defaults', async () => {
    const r = await getLearningStatus('uid');
    expect(r.gamification_nivel).toBeNull();
    expect(r.gamification_score).toBe(0);
    expect(r.gamification_logros).toEqual([]);
    expect(r.pending_approvals).toBe(0);
  });

  test('gamification existe con datos', async () => {
    mockGamExists = true;
    mockGamData = { nivel: 'Bronze', score: 80, logros: ['Bronze'] };
    const r = await getLearningStatus('uid');
    expect(r.gamification_nivel).toBe('Bronze');
    expect(r.gamification_score).toBe(80);
    expect(r.gamification_logros).toEqual(['Bronze']);
  });

  test('gamification existe pero nivel null => null', async () => {
    mockGamExists = true;
    mockGamData = { nivel: null, score: 0, logros: [] };
    const r = await getLearningStatus('uid');
    expect(r.gamification_nivel).toBeNull();
    expect(r.gamification_score).toBe(0);
  });

  test('training_data con 3 pendientes', async () => {
    mockTrainingSize = 3;
    const r = await getLearningStatus('uid');
    expect(r.pending_approvals).toBe(3);
  });

  test('gamification throws => silenciado, nivel null', async () => {
    mockGamGetThrows = true;
    const r = await getLearningStatus('uid');
    expect(r.gamification_nivel).toBeNull();
  });

  test('training_data throws => silenciado, pending=0', async () => {
    mockTrainingGetThrows = true;
    const r = await getLearningStatus('uid');
    expect(r.pending_approvals).toBe(0);
  });

  test('gamification sin logros usa []', async () => {
    mockGamExists = true;
    mockGamData = { nivel: 'Silver', score: 200 };
    const r = await getLearningStatus('uid');
    expect(r.gamification_logros).toEqual([]);
  });
});

// ── getPlan ───────────────────────────────────────────────────────────────────
describe('getPlan', () => {
  test('owner no existe: plan free defaults', async () => {
    mockOwnerExists = false;
    const r = await getPlan('uid');
    expect(r.plan_name).toBe('free');
    expect(r.plan_price).toBe(0);
    expect(r.plan_currency).toBe('USD');
    expect(r.plan_renewal_date).toBeNull();
    expect(r.plan_active).toBe(true);
  });

  test('owner existe con plan: retorna datos', async () => {
    mockOwnerExists = true;
    mockOwnerData = { plan_name: 'pro', plan_price: 29, plan_currency: 'USD', plan_renewal_date: '2026-06-01', plan_active: true };
    const r = await getPlan('uid');
    expect(r.plan_name).toBe('pro');
    expect(r.plan_price).toBe(29);
    expect(r.plan_renewal_date).toBe('2026-06-01');
  });

  test('plan_active=false => false', async () => {
    mockOwnerExists = true;
    mockOwnerData = { plan_active: false };
    const r = await getPlan('uid');
    expect(r.plan_active).toBe(false);
  });
});
