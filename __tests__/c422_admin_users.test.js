"use strict";

// C-422: /api/admin/users endpoint -- bypass Firestore rules via Admin SDK

const mockFsInstance = { collection: jest.fn() };

jest.mock("firebase-admin", () => {
  const verifyIdToken = jest.fn();
  return {
    app: jest.fn(() => ({ name: "test-app" })),
    auth: jest.fn(() => ({ verifyIdToken })),
    firestore: jest.fn(() => mockFsInstance),
    __mocks: { verifyIdToken },
  };
});

const admin = require("firebase-admin");
const express = require("express");
const request = require("supertest");
const { requireAuth, requireAdmin } = require("../core/require_role");

const TOKEN_USER = "token-user";
const TOKEN_ADMIN = "token-admin";

function setupAuth() {
  admin.__mocks.verifyIdToken.mockImplementation(async (tok) => {
    if (tok === TOKEN_USER) return { uid: "user_uid", email: "user@test.com", role: "user" };
    if (tok === TOKEN_ADMIN) return { uid: "admin_uid", email: "admin@test.com", role: "admin" };
    const e = new Error("invalid"); e.code = "auth/invalid-id-token"; throw e;
  });
}

function buildApp() {
  const app = express();
  app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const snapshot = await admin.firestore().collection("users").get();
      const users = [];
      snapshot.forEach(doc => users.push({ uid: doc.id, ...doc.data() }));
      console.log("[/api/admin/users] " + users.length + " users returned");
      res.json(users);
    } catch (e) {
      console.error("[/api/admin/users] ERROR:", e.message);
      res.status(500).json({ error: "Failed to load users: " + e.message });
    }
  });
  return app;
}

beforeEach(() => {
  admin.__mocks.verifyIdToken.mockReset && admin.__mocks.verifyIdToken.mockReset();
  mockFsInstance.collection.mockReset && mockFsInstance.collection.mockReset();
  setupAuth();
  delete process.env.ADMIN_EMAILS;
});

describe("C-422 -- /api/admin/users (rrAuth+rrAdmin, Admin SDK bypass)", () => {
  test("401 without Authorization header", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/admin/users");
    expect(res.status).toBe(401);
  });

  test("403 for non-admin user", async () => {
    mockFsInstance.collection.mockReturnValue({ doc: jest.fn(() => ({ get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }) })), get: jest.fn().mockResolvedValue({ forEach: jest.fn() }) });
    const app = buildApp();
    const res = await request(app).get("/api/admin/users").set("Authorization", "Bearer " + TOKEN_USER);
    expect(res.status).toBe(403);
  });

  test("200 admin returns user list from Firestore", async () => {
    const mockUsers = [
      { id: "uid1", data: () => ({ name: "Mariano", email: "m@test.com", plan: "monthly" }) },
      { id: "uid2", data: () => ({ name: "Ana", email: "ana@test.com", plan: "trial" }) },
    ];
    const mockSnapshot = { forEach: fn => mockUsers.forEach(fn) };
    mockFsInstance.collection.mockReturnValue({ get: jest.fn().mockResolvedValue(mockSnapshot) });
    const app = buildApp();
    const res = await request(app).get("/api/admin/users").set("Authorization", "Bearer " + TOKEN_ADMIN);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(res.body[0].uid).toBe("uid1");
    expect(res.body[0].name).toBe("Mariano");
  });

  test("200 admin returns empty array when no users", async () => {
    const mockSnapshot = { forEach: jest.fn() };
    mockFsInstance.collection.mockReturnValue({ get: jest.fn().mockResolvedValue(mockSnapshot) });
    const app = buildApp();
    const res = await request(app).get("/api/admin/users").set("Authorization", "Bearer " + TOKEN_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("500 on Firestore error", async () => {
    mockFsInstance.collection.mockReturnValue({ get: jest.fn().mockRejectedValue(new Error("Firestore unavailable")) });
    const app = buildApp();
    const res = await request(app).get("/api/admin/users").set("Authorization", "Bearer " + TOKEN_ADMIN);
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Firestore unavailable");
  });
});
