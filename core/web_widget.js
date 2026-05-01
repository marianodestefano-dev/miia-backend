"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

function generateWidgetSnippet(uid, opts) {
  if (!uid) throw new Error("uid required");
  const color = (opts && opts.color) || "#25D366";
  const position = (opts && opts.position) || "bottom-right";
  const greeting = (opts && opts.greeting) || "Hola! Como puedo ayudarte?";
  const NL = String.fromCharCode(10);
  return [
    "<!-- MIIA Chat Widget -->",
    "<script>",
    "(function() {",
    "  var w = document.createElement('div');",
    "  w.id = 'miia-widget';",
    "  w.dataset.uid = '" + uid + "';",
    "  w.dataset.color = '" + color + "';",
    "  w.dataset.position = '" + position + "';",
    "  w.dataset.greeting = '" + greeting + "';",
    "  document.body.appendChild(w);",
    "})();",
    "</script>",
    "<!-- End MIIA Widget -->",
  ].join(NL);
}

async function createWidgetConfig(uid, opts) {
  if (!uid) throw new Error("uid required");
  const config = {
    uid,
    color: (opts && opts.color) || "#25D366",
    position: (opts && opts.position) || "bottom-right",
    greeting: (opts && opts.greeting) || "Hola! Como puedo ayudarte?",
    active: true, updatedAt: Date.now(),
  };
  await getDb().collection("widget_configs").doc(uid).set(config);
  const snippet = generateWidgetSnippet(uid, config);
  return { ...config, snippet };
}

module.exports = { generateWidgetSnippet, createWidgetConfig, __setFirestoreForTests };
