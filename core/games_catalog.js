"use strict";

const GAME_CATEGORIES = Object.freeze(["trivia", "wordgame", "quiz", "math", "memory", "riddles"]);

const CATALOG = Object.freeze([
  { id: "trivia_general", name: "Trivia General", category: "trivia", minPlayers: 1, maxPlayers: 4, durationMin: 10 },
  { id: "trivia_sports", name: "Trivia Deportes", category: "trivia", minPlayers: 1, maxPlayers: 4, durationMin: 10 },
  { id: "trivia_science", name: "Trivia Ciencia", category: "trivia", minPlayers: 1, maxPlayers: 4, durationMin: 10 },
  { id: "trivia_history", name: "Trivia Historia", category: "trivia", minPlayers: 1, maxPlayers: 4, durationMin: 10 },
  { id: "trivia_geo", name: "Trivia Geografia", category: "trivia", minPlayers: 1, maxPlayers: 4, durationMin: 10 },
  { id: "word_hangman", name: "Ahorcado", category: "wordgame", minPlayers: 1, maxPlayers: 2, durationMin: 5 },
  { id: "word_scramble", name: "Palabras Mezcladas", category: "wordgame", minPlayers: 1, maxPlayers: 2, durationMin: 5 },
  { id: "word_chain", name: "Cadena de Palabras", category: "wordgame", minPlayers: 2, maxPlayers: 6, durationMin: 15 },
  { id: "quiz_culture", name: "Quiz Cultura General", category: "quiz", minPlayers: 1, maxPlayers: 8, durationMin: 20 },
  { id: "quiz_pop", name: "Quiz Pop Culture", category: "quiz", minPlayers: 1, maxPlayers: 8, durationMin: 20 },
  { id: "math_speed", name: "Matematica Rapida", category: "math", minPlayers: 1, maxPlayers: 4, durationMin: 5 },
  { id: "math_riddles", name: "Acertijos Matematicos", category: "math", minPlayers: 1, maxPlayers: 4, durationMin: 10 },
  { id: "memory_classic", name: "Memoria Clasico", category: "memory", minPlayers: 1, maxPlayers: 4, durationMin: 10 },
  { id: "riddle_easy", name: "Adivinanzas Faciles", category: "riddles", minPlayers: 1, maxPlayers: 10, durationMin: 10 },
  { id: "riddle_hard", name: "Adivinanzas Dificiles", category: "riddles", minPlayers: 1, maxPlayers: 10, durationMin: 15 },
]);

function listGames(filters) {
  let games = CATALOG.slice();
  if (filters && filters.category) games = games.filter(g => g.category === filters.category);
  if (filters && filters.query) {
    const q = filters.query.toLowerCase();
    games = games.filter(g => g.name.toLowerCase().includes(q) || g.category.toLowerCase().includes(q));
  }
  return games;
}

function getGame(gameId) {
  return CATALOG.find(g => g.id === gameId) || null;
}

module.exports = { listGames, getGame, CATALOG, GAME_CATEGORIES };
