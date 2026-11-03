import crypto from "node:crypto";

export const START = [0, 13, 26, 39];
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const ring = (c, p) => (START[c] + p) % 52;

export const progress = (p) => p.tokens.reduce((a, t) => a + (t < 0 ? 0 : t + 1), 0);

export function legalMoves(g, seat) {
  const d = g.dice, out = [];
  if (!d) return out;
  g.players[seat].tokens.forEach((t, i) => {
    if (t === -1 ? d === 6 : t + d <= 56) out.push(i);
  });
  return out;
}

export function nextTurn(g) {
  g.turn = (g.turn + 1) % g.players.length;
  g.dice = null;
  g.turnAt = Date.now();
}

const say = (g, s) => { g.log.push(s); if (g.log.length > 20) g.log.shift(); };

export function roll(g) {
  const p = g.players[g.turn];
  g.dice = crypto.randomInt(1, 7);
  g.turnAt = Date.now();
  say(g, `${p.name} rolled ${g.dice}`);
  if (!legalMoves(g, g.turn).length) { say(g, `${p.name} cannot move`); nextTurn(g); }
}

export function applyMove(g, seat, ti) {
  const p = g.players[seat], d = g.dice;
  const t = p.tokens[ti] === -1 ? 0 : p.tokens[ti] + d;
  p.tokens[ti] = t;
  g.turnAt = Date.now();
  if (t <= 50 && !SAFE.has(ring(p.color, t))) {
    const r = ring(p.color, t);
    g.players.forEach((q, s) => {
      if (s === seat) return;
      q.tokens.forEach((u, j) => {
        if (u >= 0 && u <= 50 && ring(q.color, u) === r) { q.tokens[j] = -1; say(g, `${p.name} sent ${q.name} home`); }
      });
    });
  }
  if (p.tokens.every((x) => x === 56)) {
    g.status = "done"; g.winner = seat; g.dice = null;
    say(g, `${p.name} wins`);
    return;
  }
  if (d === 6) { g.dice = null; } else nextTurn(g);
}

export function bestMove(g, seat) {
  const p = g.players[seat], d = g.dice;
  const score = (i) => {
    const t = p.tokens[i], n = t === -1 ? 0 : t + d;
    if (n === 56) return 100;
    if (n <= 50 && !SAFE.has(ring(p.color, n)) &&
      g.players.some((q, s) => s !== seat && q.tokens.some((u) => u >= 0 && u <= 50 && ring(q.color, u) === ring(p.color, n)))) return 90;
    return t === -1 ? 80 : n;
  };
  return legalMoves(g, seat).sort((a, b) => score(b) - score(a))[0];
}
