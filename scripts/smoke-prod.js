'use strict';
const https = require("https");
const http = require("http");

const BASE_URL = process.env.MIIA_PROD_URL || "http://localhost:3000";
const TIMEOUT_MS = 5000;

const ENDPOINTS = [
  { path: "/health", expectedStatus: 200, name: "Health" },
  { path: "/api/health/deep", expectedStatus: 200, name: "Health Deep" },
  { path: "/api/metrics", expectedStatus: 200, name: "Prometheus Metrics" },
  { path: "/api/health/status", expectedStatus: 200, name: "Health Status" },
  { path: "/api/version", expectedStatus: [200, 404], name: "Version" },
  { path: "/api/cotizacion/paises", expectedStatus: [200, 401, 403], name: "Cotizacion Paises" },
  { path: "/api/f1/calendar", expectedStatus: [200, 401, 403], name: "F1 Calendar" },
  { path: "/api/f1/standings", expectedStatus: [200, 401, 403], name: "F1 Standings" },
  { path: "/api/businesses", expectedStatus: [200, 401, 403], name: "Businesses" },
  { path: "/nonexistent-path", expectedStatus: 404, name: "404 Handler" },
];

async function checkEndpoint(endpoint) {
  return new Promise((resolve) => {
    const url = new URL(endpoint.path, BASE_URL);
    const protocol = url.protocol === "https:" ? https : http;
    const req = protocol.get(url.toString(), { timeout: TIMEOUT_MS }, (res) => {
      const expected = Array.isArray(endpoint.expectedStatus) ? endpoint.expectedStatus : [endpoint.expectedStatus];
      const ok = expected.includes(res.statusCode);
      resolve({ name: endpoint.name, status: res.statusCode, ok, path: endpoint.path });
    });
    req.on("error", (e) => resolve({ name: endpoint.name, status: 0, ok: false, path: endpoint.path, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ name: endpoint.name, status: 0, ok: false, path: endpoint.path, error: "timeout" }); });
  });
}

async function runSmoke() {
  console.log("[SMOKE] Starting smoke test against:", BASE_URL);
  const results = await Promise.all(ENDPOINTS.map(checkEndpoint));
  let passed = 0, failed = 0;
  results.forEach(r => {
    const icon = r.ok ? "✅" : "❌";
    console.log(icon + " " + r.name + " -> " + r.status + (r.error ? " (" + r.error + ")" : ""));
    if (r.ok) passed++; else failed++;
  });
  console.log("");
  console.log("[SMOKE] Results: " + passed + "/" + (passed + failed) + " passed");
  if (failed > 0) { console.error("[SMOKE] FAILED: " + failed + " endpoint(s) failed"); process.exit(1); }
  console.log("[SMOKE] All checks PASS");
}

runSmoke().catch(e => { console.error("[SMOKE] Fatal error:", e); process.exit(1); });
