"use strict";
const { randomUUID } = require("crypto");

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const RECIPE_CATEGORIES = Object.freeze(["desayuno", "almuerzo", "cena", "snack", "postre", "bebida"]);
const VISION_CONFIDENCE_THRESHOLD = 0.7;

function parseIngredientsFromVision(visionLabels) {
  const labels = Array.isArray(visionLabels) ? visionLabels : [];
  const ingredients = labels.filter(l => l.confidence >= VISION_CONFIDENCE_THRESHOLD).map(l => l.label.toLowerCase());
  return { ingredients, count: ingredients.length, highConfidence: ingredients.length > 0 };
}

async function analyzeKitchenPhoto(uid, imageUrl, visionLabels) {
  const parsed = parseIngredientsFromVision(visionLabels);
  const analysis = { id: randomUUID(), uid, imageUrl, ingredients: parsed.ingredients, ingredientCount: parsed.count, analyzedAt: new Date().toISOString() };
  await getDb().collection("kitchen_analyses").doc(analysis.id).set(analysis);
  return analysis;
}

async function suggestRecipes(uid, ingredients, category) {
  if (category && !RECIPE_CATEGORIES.includes(category)) throw new Error("Invalid category: " + category);
  const snap = await getDb().collection("recipes").get();
  const recipes = [];
  snap.forEach(doc => {
    const d = doc.data();
    if (category && d.category !== category) return;
    const matches = (d.ingredients || []).filter(i => ingredients.includes(i));
    if (matches.length > 0) recipes.push({ ...d, matchedIngredients: matches, matchScore: matches.length / (d.ingredients || []).length });
  });
  return recipes.sort((a, b) => b.matchScore - a.matchScore).slice(0, 5);
}

async function saveRecipe(uid, recipe) {
  if (!recipe.name) throw new Error("Recipe name required");
  if (!RECIPE_CATEGORIES.includes(recipe.category)) throw new Error("Invalid category: " + recipe.category);
  const saved = { id: randomUUID(), uid, name: recipe.name, category: recipe.category, ingredients: recipe.ingredients || [], steps: recipe.steps || [], createdAt: new Date().toISOString() };
  await getDb().collection("recipes").doc(saved.id).set(saved);
  return saved;
}

async function getRecipesByCategory(uid, category) {
  const snap = await getDb().collection("recipes").where("uid", "==", uid).get();
  const recipes = [];
  snap.forEach(doc => { const d = doc.data(); if (!category || d.category === category) recipes.push(d); });
  return recipes;
}

module.exports = { __setFirestoreForTests, RECIPE_CATEGORIES, VISION_CONFIDENCE_THRESHOLD,
  parseIngredientsFromVision, analyzeKitchenPhoto, suggestRecipes, saveRecipe, getRecipesByCategory };
