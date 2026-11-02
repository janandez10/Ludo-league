import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const SECRET = process.env.SESSION_SECRET || "";
const CODE_TTL = 10 * 60 * 1000;
const RESEND_WAIT = 60 * 1000;
const MAX_TRIES = 5;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const hmac = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");

function normalizePhone(raw) {
  const m = String(raw || "").replace(/[\s-]/g, "").match(/^(?:\+?256|0)(7\d{8})$/);
  return m ? "+256" + m[1] : null;
}

function passwordProblem(p) {
  if (typeof p !== "string" || p.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return "Password needs at least one letter and one number.";
  return null;
}

function hashPassword(p) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(p, salt, 64).toString("hex");
}

function checkPassword(p, stored) {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(p, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}

function makeToken(phone) {
  const body = Buffer.from(JSON.stringify({ phone, exp: Date.now() + 30 * 86400000 })).toString("base64url");
  return body + "." + hmac(body);
}

async function sendSms(phone, code) {
  const message = `Your Ludo League code is ${code}. It expires in 10 minutes. Do not share it.`;
  if (!process.env.AT_API_KEY) {
    if (process.env.DEV_SHOW_CODE === "true") return { dev: code };
    throw new Error("SMS is not set up yet.");
  }
  const host = process.env.AT_USERNAME === "sandbox" ? "api.sandbox.africastalking.com" : "api.africastalking.com";
  const form = new URLSearchParams({ username: process.env.AT_USERNAME, to: phone, message });
  if (process.env.AT_SENDER_ID) form.set("from", process.env.AT_SENDER_ID);
  const res = await fetch(`https://${host}/version1/messaging`, {
    method: "POST",
    headers: { apiKey: process.env.AT_API_KEY, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) throw new Error("The SMS could not be sent.");
  return {};
}

async function issueCode(users, user) {
  const now = Date.now();
  if (user.codeSentAt && now - user.codeSentAt < RESEND_WAIT) {
    return { error: "Wait a minute before asking for another code.", status: 429 };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  user.codeHash = hmac(user.phone + ":" + code);
  user.codeExp = now + CODE_TTL;
  user.codeSentAt = now;
  user.tries = 0;
  await users.setJSON(user.phone, user);
  try {
    return { sent: await sendSms(user.phone, code) };
  } catch (e) {
    return { error: e.message, status: 502 };
  }
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Not allowed." }, 405);
  if (SECRET.length < 16) return json({ error: "Server is missing SESSION_SECRET." }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }

  const phone = normalizePhone(body.phone);
  if (!phone) return json({ error: "Enter a valid Uganda number, like 0745805716." }, 400);

  const users = getStore("users");
  const user = await users.get(phone, { type: "json" });

  if (body.action === "register") {
    const problem = passwordProblem(body.password);
    if (problem) return json({ error: problem }, 400);
    if (user && user.verified) return json({ error: "This number is already registered. Log in instead." }, 409);
    const fresh = { phone, passHash: hashPassword(body.password), verified: false, createdAt: Date.now(), ...(user ? { codeSentAt: user.codeSentAt } : {}) };
    const r = await issueCode(users, fresh);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ step: "code", phone, ...(r.sent.dev ? { devCode: r.sent.dev } : {}) });
  }

  if (body.action === "resend") {
    if (!user || user.verified) return json({ error: "Nothing to verify for this number." }, 400);
    const r = await issueCode(users, user);
    if (r.error) return json({ error: r.error }, r.status);
    return json({ step: "code", phone, ...(r.sent.dev ? { devCode: r.sent.dev } : {}) });
  }

  if (body.action === "verify") {
    if (!user || !user.codeHash) return json({ error: "Request a new code first." }, 400);
    if (Date.now() > user.codeExp) return json({ error: "That code has expired. Request a new one." }, 400);
    if (user.tries >= MAX_TRIES) return json({ error: "Too many wrong codes. Request a new one." }, 429);
    const ok = hmac(phone + ":" + String(body.code || "").trim()) === user.codeHash;
    if (!ok) {
      user.tries += 1;
      await users.setJSON(phone, user);
      return json({ error: "Wrong code. Check the SMS and try again." }, 400);
    }
    user.verified = true;
    delete user.codeHash;
    await users.setJSON(phone, user);
    return json({ token: makeToken(phone), phone });
  }

  if (body.action === "login") {
    if (!user || !checkPassword(String(body.password || ""), user.passHash)) {
      return json({ error: "Wrong number or password." }, 401);
    }
    if (!user.verified) {
      const r = await issueCode(users, user);
      if (r.error && r.status !== 429) return json({ error: r.error }, r.status);
      return json({ step: "code", phone, ...(r.sent && r.sent.dev ? { devCode: r.sent.dev } : {}) });
    }
    return json({ token: makeToken(phone), phone });
  }

  return json({ error: "Unknown action." }, 400);
};

export const config = { path: "/api/auth" };
