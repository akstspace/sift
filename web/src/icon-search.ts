import type { CatalogIcon } from "./types";

// Same bounded ranking as internal/sift/icon_search.go. Shared golden vectors
// cover both, so offline picker results and CLI/API ordering stay consistent.
function words(value: string) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function distance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

const indexes = new WeakMap<CatalogIcon[], { icon: CatalogIcon; fields: string[] }[]>();

function wordScore(query: string, word: string) {
  if (query === word) return 0;
  if (word.startsWith(query)) return 10 + Math.min(word.length - query.length, 9);
  if (word.includes(query)) return 20 + Math.min(word.length - query.length, 9);
  let best = 1000;
  if (query.length >= 3) {
    let pos = 0;
    for (const char of word) {
      if (pos < query.length && query[pos] === char) pos++;
    }
    if (pos === query.length) best = 40 + Math.min(word.length - query.length, 9);
    if (word.length <= 32 && Math.abs(query.length - word.length) <= 2) {
      const edits = distance(query, word);
      if (edits <= (query.length >= 5 ? 2 : 1)) best = Math.min(best, 30 + edits * 10);
    }
  }
  return best;
}

export function searchIcons(catalog: CatalogIcon[], query: string): CatalogIcon[] {
  const tokens = words(words(query).join(" ").slice(0, 80)).slice(0, 8);
  let index = indexes.get(catalog);
  if (!index) {
    index = catalog.map(icon => ({ icon, fields: [...new Set(words(`${icon.id} ${icon.name} ${icon.category} ${icon.aliases.join(" ")}`))] }));
    indexes.set(catalog, index);
  }
  const scores = new Map<string, number>();
  function scoreWord(token: string, field: string) {
    const key = `${token}:${field}`;
    let score = scores.get(key);
    if (score === undefined) {
      score = wordScore(token, field);
      scores.set(key, score);
    }
    return score;
  }
  return index.map(({ icon, fields }) => {
    const score = tokens.reduce((sum, token) => sum + fields.reduce((best, field) => Math.min(best, scoreWord(token, field)), 1000), 0);
    return { icon, score };
  }).filter(match => match.score < 1000).sort((a, b) => a.score - b.score).map(match => match.icon);
}
