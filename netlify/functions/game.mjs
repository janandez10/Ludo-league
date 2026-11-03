import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { legalMoves, roll, applyMove, bestMove, progress } from "./ludo-engine.mjs";

const SECRET = process.env.SESSION_SECRET || "";
const STAKES = [0, 200, 500, 1000, 2000];
const DAY = 86400000;
let users, games;

const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const E = (m, s = 400) => J({ error: m }, s);

function who(req) {
  const [b, s] = (req.headers.get("authorization") || "").slice(7).split(".");
  if (!b || !s) return null;
  const h = crypto.createHmac("sha256", SECRET).update(b).digest("hex");
  if (h.length !== s.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(s))) return null;
  try { const d = JSON.parse(Buffer.from(b, "base64url")); return d.exp > Date.now() ? d.phone : null; } catch { return null; }
}

async function getUser(phone) {
  const u = await users.get(phone, { type: "json" });
  if (!u || !u.verified) return null;
  u.coins ??= 1000; u.played ??= 0; u.wins ??= 0; u.points ??= 0; u.name ??= "Player " + phone.slice(-3);
  return u;
}
const saveU = (u) => users.setJSON(u.phone, u);
const loadG = (id) => games.get("g:" + String(id).replace(/[^a-f0-9]/g, ""), { type: "json" });
const saveG = (g) => games.setJSON("g:" + g.id, g);
const newP = (u) => ({ phone: u.phone, name: u.name, bot: false, tokens: [-1, -1, -1, -1] });
const botP = (n) => ({ phone: null, name: "Bot " + n, bot: true, tokens: [-1, -1, -1, -1] });

function start(g) {
  const C = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] }[g.players.length];
  g.players.forEach((p, i) => (p.color = C[i]));
  Object.assign(g, { status: "playing", turn: 0, dice: null, turnAt: Date.now(), log: ["Game started"] });
}

function step(g) {
  let n = 0;
  while (g.status === "playing" && n++ < 600) {
    const p = g.players[g.turn];
    if (!p.bot && Date.now() - g.turnAt > 60000) { p.bot = true; p.name += " (bot)"; g.log.push(p.name + " took over"); }
    if (!p.bot) break;
    if (!g.dice) roll(g);
    if (g.status === "playing" && g.dice) applyMove(g, g.turn, bestMove(g, g.turn));
  }
}

async function settle(g) {
  if (g.settled) return;
  g.settled = true;
  const w = g.players[g.winner], hum = g.players.filter((p) => p.phone), pot = g.stake * hum.length;
  const second = g.players.map((_, i) => i).filter((i) => i !== g.winner).sort((a, b) => progress(g.players[b]) - progress(g.players[a]))[0];
  for (const p of hum) {
    const u = await getUser(p.phone); if (!u) continue;
    const i = g.players.indexOf(p);
    u.played++;
    if (w.bot) u.coins += g.stake;
    else if (i === g.winner) { u.wins++; u.points += 3; u.coins += pot; }
    else if (i === second && g.players.length > 2 && !p.bot) u.points += 1;
    await saveU(u);
  }
  g.result = { winner: w.name, pot, refund: !!w.bot && g.stake > 0 };
}

function view(g, phone) {
  const seat = g.players.findIndex((p) => p.phone === phone);
  return {
    id: g.id, stake: g.stake, max: g.max, status: g.status, turn: g.turn, dice: g.dice, winner: g.winner,
    host: g.host === phone, seat, result: g.result, log: g.log.slice(-5),
    legal: g.status === "playing" && g.turn === seat ? legalMoves(g, seat) : [],
    players: g.players.map((p) => ({ name: p.name, bot: p.bot, color: p.color, tokens: p.tokens, me: p.phone === phone })),
    pot: g.stake * g.players.filter((p) => p.phone).length,
  };
}

export default async (req) => {
  if (req.method !== "POST") return E("Not allowed.", 405);
  if (SECRET.length < 16) return E("Server is missing SESSION_SECRET.", 500);
  users = getStore({ name: "users", consistency: "strong" });
  games = getStore({ name: "games", consistency: "strong" });
  const phone = who(req);
  if (!phone) return E("Please log in again.", 401);
  let b; try { b = await req.json(); } catch { return E("Bad request."); }
  const u = await getUser(phone);
  if (!u) return E("Please log in again.", 401);

  switch (b.a) {
    case "me":
      return J({ name: u.name, coins: u.coins, points: u.points, wins: u.wins, played: u.played, claimIn: Math.max(0, (u.lastClaim || 0) + DAY - Date.now()) });
    case "claim": {
      const left = (u.lastClaim || 0) + DAY - Date.now();
      if (left > 0) return E("Free coins are ready in " + Math.ceil(left / 3600000) + " hours.");
      u.coins += 500; u.lastClaim = Date.now(); await saveU(u);
      return J({ coins: u.coins });
    }
    case "setname": {
      const n = String(b.name || "").trim().slice(0, 14);
      if (n.length < 2) return E("Name needs 2 to 14 characters.");
      u.name = n; await saveU(u); return J({ name: n });
    }
    case "standings": {
      const { blobs } = await users.list();
      const rows = [];
      for (const k of blobs.slice(0, 100)) {
        const x = await users.get(k.key, { type: "json" });
        if (x && x.verified && x.played > 0) rows.push({ name: x.name || "Player " + k.key.slice(-3), played: x.played, wins: x.wins || 0, points: x.points || 0 });
      }
      rows.sort((a, c) => c.points - a.points || c.wins - a.wins);
      return J({ rows: rows.slice(0, 50) });
    }
    case "lobby": {
      const { blobs } = await games.list({ prefix: "g:" });
      const out = [];
      for (const k of blobs.slice(0, 40)) {
        const g = await games.get(k.key, { type: "json" });
        if (g && g.status === "waiting" && g.players.length < g.max && Date.now() - g.createdAt < 1800000)
          out.push({ id: g.id, stake: g.stake, max: g.max, count: g.players.length, host: g.players[0].name, mine: g.players.some((p) => p.phone === phone) });
      }
      return J({ tables: out });
    }
    case "create": {
      const stake = +b.stake || 0, max = +b.max || 2, bots = +b.bots || 0;
      if (!STAKES.includes(stake) || max < 2 || max > 4 || bots < 0 || bots > max - 1) return E("Bad table.");
      if (stake && bots) return E("Bots are only for free tables.");
      if (u.coins < stake) return E("Not enough coins.");
      u.coins -= stake; await saveU(u);
      const g = { id: crypto.randomBytes(4).toString("hex"), stake, max, host: phone, status: "waiting", players: [newP(u)], createdAt: Date.now(), log: [] };
      for (let i = 1; i <= bots; i++) g.players.push(botP(i));
      if (g.players.length === max) start(g);
      await saveG(g);
      return J({ id: g.id });
    }
    case "join": {
      const g = await loadG(b.id);
      if (!g || g.status !== "waiting") return E("Table is not open.");
      if (g.players.some((p) => p.phone === phone)) return J({ id: g.id });
      if (g.players.length >= g.max) return E("Table is full.");
      if (u.coins < g.stake) return E("Not enough coins.");
      u.coins -= g.stake; await saveU(u);
      g.players.push(newP(u));
      if (g.players.length === g.max) start(g);
      await saveG(g);
      return J({ id: g.id });
    }
    case "leave": {
      const g = await loadG(b.id);
      if (!g) return J({ ok: true });
      const i = g.players.findIndex((p) => p.phone === phone);
      if (i < 0) return J({ ok: true });
      if (g.status === "waiting") {
        u.coins += g.stake; await saveU(u);
        g.players.splice(i, 1);
        const h = g.players.find((p) => p.phone);
        if (!h) g.status = "closed"; else g.host = h.phone;
      } else if (g.status === "playing") {
        g.players[i].bot = true; g.players[i].name += " (bot)";
        step(g);
        if (g.status === "done") await settle(g);
      }
      await saveG(g);
      return J({ ok: true });
    }
    case "addbot": case "start": {
      const g = await loadG(b.id);
      if (!g || g.status !== "waiting" || g.host !== phone) return E("Only the host can do that.");
      if (b.a === "addbot") {
        if (g.stake) return E("Bots are only for free tables.");
        if (g.players.length >= g.max) return E("Table is full.");
        g.players.push(botP(g.players.filter((p) => p.bot).length + 1));
        if (g.players.length === g.max) start(g);
      } else {
        if (g.players.length < 2) return E("You need at least 2 players.");
        start(g);
      }
      await saveG(g);
      return J({ ok: true });
    }
    case "state": case "roll": case "move": {
      const g = await loadG(b.id);
      if (!g) return E("Table not found.", 404);
      const seat = g.players.findIndex((p) => p.phone === phone);
      if (seat < 0) return E("You are not at this table.", 403);
      const before = JSON.stringify(g);
      if (g.status === "playing" && b.a !== "state") {
        if (g.turn !== seat) return E("Not your turn.");
        if (b.a === "roll") { if (g.dice) return E("You already rolled."); roll(g); }
        else {
          if (!g.dice || !legalMoves(g, seat).includes(+b.token)) return E("Tap a glowing token.");
          applyMove(g, seat, +b.token);
        }
      }
      step(g);
      if (g.status === "done") await settle(g);
      if (JSON.stringify(g) !== before) await saveG(g);
      return J(view(g, phone));
    }
  }
  return E("Unknown action.");
};

export const config = { path: "/api/game" };
