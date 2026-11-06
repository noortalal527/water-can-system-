// Hostel Water Cans — backend (Netlify Function + Netlify Blobs storage)
// The website calls /api. Everything is stored in one Blobs store called "water-cans".
import { getStore } from "@netlify/blobs";
import { scryptSync, randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";
import SEED from "./seed-data.mjs";

export const config = { path: "/api" };

// ---------- settings you can change ----------
const TIME_ZONE = "Asia/Karachi";      // months and days are counted in this time zone
const SHOW_NAMES_ON_LOGIN = true;       // name buttons on the login screen
const MAX_LOGIN_FAILS = 8;              // wrong passwords allowed per connection in 10 minutes
const SESSION_DAYS = 60;                // how long people stay logged in

// ---------- storage layout ----------
// settings              {hostel, currency, price}
// users                 {username: {username, name, role, pass, legacy, salt, order, created}}
// o/<YYYY-MM>/<key>     one blob per order (the key itself holds the order details, see orderKey)
// attempts/<hash>       wrong-password counter for one connection
// meta/secret           random key that signs login cookies (made automatically)
// meta/imported         set once your old data has been imported
const store = () => getStore({ name: "water-cans", consistency: "strong" });

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify({ ok: status < 400, ...data }), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const fail = (error, status = 400) => json({ error }, status);

// ---------- time helpers ----------
function zoned(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(date).map(x => [x.type, x.value]));
  return { month: `${p.year}-${p.month}`, day: `${p.year}-${p.month}-${p.day}` };
}
const validMonth = m => (typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) ? m : zoned().month;

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(pw, salt, 32).toString("hex")}`;
}
function checkPassword(user, pw) {
  if (!pw) return false;
  if (user.pass) {
    const [, salt, hex] = user.pass.split("$");
    const a = Buffer.from(hex, "hex"), b = scryptSync(pw, salt, 32);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  if (user.legacy) { // passwords from the Claude version: sha256("<salt>:<password>")
    const h = createHash("sha256").update(`${user.salt || user.username}:${pw}`).digest("hex");
    return h.length === user.legacy.length && timingSafeEqual(Buffer.from(h), Buffer.from(user.legacy));
  }
  return false;
}
const pwVersion = u => createHash("sha256").update(`${u.pass || ""}|${u.legacy || ""}`).digest("hex").slice(0, 16);

// ---------- login cookie ----------
async function secret(s) {
  let k = await s.get("meta/secret");
  if (!k) { k = randomBytes(32).toString("hex"); await s.set("meta/secret", k); k = (await s.get("meta/secret")) || k; }
  return k;
}
const b64 = s => Buffer.from(s).toString("base64url");
async function makeCookie(s, user, secure) {
  const body = b64(JSON.stringify({ u: user.username, v: pwVersion(user), e: Date.now() + SESSION_DAYS * 864e5 }));
  const sig = createHmac("sha256", await secret(s)).update(body).digest("base64url");
  return `hwc=${body}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}
const clearCookie = secure => `hwc=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
async function currentUser(s, req, users) {
  const m = /(?:^|;\s*)hwc=([^;]+)/.exec(req.headers.get("cookie") || "");
  if (!m) return null;
  const [body, sig] = m[1].split(".");
  if (!body || !sig) return null;
  const good = createHmac("sha256", await secret(s)).update(body).digest("base64url");
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  const u = users[p.u];
  if (!u || p.e < Date.now() || p.v !== pwVersion(u)) return null; // removed, expired or password changed
  return u;
}

// ---------- data ----------
async function getUsers(s) { return (await s.get("users", { type: "json" })) || {}; }
async function saveUsers(s, users) { await s.setJSON("users", users); }
async function getSettings(s) { return { hostel: "", currency: "Rs", price: 100, ...((await s.get("settings", { type: "json" })) || {}) }; }

// An order's details live in its key, so a whole month loads with a single list call.
// o/<month>/<time>_<random>~<username>~<cans>~<price>~<name>
function orderKey(o) {
  const t = String(Date.parse(o.at)).padStart(14, "0");
  return `o/${o.month}/${t}_${o.rand || randomBytes(4).toString("hex")}~${o.username || "-"}~${o.cans}~${o.price}~${encodeURIComponent(o.name)}`;
}
function parseOrder(key, users) {
  const [, month, rest] = key.split("/");
  const [idPart, username, cans, price, name] = rest.split("~");
  const t = Number(idPart.split("_")[0]);
  const u = username !== "-" ? users[username] : null;
  return { id: key, u: u ? username : null, name: u ? u.name : decodeURIComponent(name || ""), cans: Number(cans), price: Number(price),
           amount: Number(cans) * Number(price), at: new Date(t).toISOString(), month };
}
async function listOrders(s, prefix, users) {
  const { blobs } = await s.list({ prefix });
  return blobs.map(b => parseOrder(b.key, users)).sort((a, b) => b.at.localeCompare(a.at));
}

// Imports your data from the Claude version the first time the site runs.
async function ensureImported(s) {
  if (await s.get("meta/imported")) return;
  const users = await getUsers(s);
  if (!users.admin) users.admin = { username: "admin", name: "Admin", role: "admin", legacy: SEED.admin.legacy_hash, salt: SEED.admin.legacy_salt, order: 0, created: new Date().toISOString() };
  for (const u of SEED.users) {
    const k = u.username.toLowerCase();
    if (!users[k]) users[k] = { username: k, name: u.name, role: "member", legacy: u.legacy_hash, order: u.sort_order || 0, created: u.created_at || new Date().toISOString() };
  }
  await saveUsers(s, users);
  if (!(await s.get("settings"))) await s.setJSON("settings", { hostel: SEED.settings.hostel || "", currency: SEED.settings.currency || "Rs", price: Number(SEED.product.price) || 100 });
  for (const [i, o] of SEED.orders.entries()) { // fixed keys, so importing twice never duplicates
    await s.set(orderKey({ ...o, at: o.created_at, rand: `seed${i}` }), "1");
  }
  await s.set("meta/imported", new Date().toISOString());
}

// ---------- wrong-password limit ----------
const attemptKey = ip => "attempts/" + createHash("sha256").update(ip || "unknown").digest("hex").slice(0, 24);
async function tooManyFails(s, ip) {
  const a = await s.get(attemptKey(ip), { type: "json" });
  return a && Date.now() - a.first < 600000 && a.n >= MAX_LOGIN_FAILS;
}
async function addFail(s, ip) {
  const k = attemptKey(ip), a = await s.get(k, { type: "json" });
  const fresh = !a || Date.now() - a.first >= 600000;
  await s.setJSON(k, fresh ? { n: 1, first: Date.now() } : { n: a.n + 1, first: a.first });
}

const members = users => Object.values(users).filter(u => u.role === "member")
  .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.created).localeCompare(String(b.created)))
  .map(u => ({ u: u.username, name: u.name, order: u.order || 0 }));
const publicMe = u => u ? { u: u.username, name: u.name, role: u.role } : null;
const cleanName = v => String(v || "").replace(/\s+/g, " ").trim().slice(0, 80);
const cleanUser = v => String(v || "").trim().toLowerCase();
const csvCell = v => `"${String(v).replace(/"/g, '""')}"`;

// ---------- request handler ----------
export default async (req, context) => {
  const s = store();
  const secure = new URL(req.url).protocol === "https:";
  try { await ensureImported(s); } catch (e) { return fail("The storage isn’t available yet. Try again in a minute.", 500); }
  const url = new URL(req.url);
  const users = await getUsers(s);
  const me = await currentUser(s, req, users);

  if (req.method === "GET") {
    const action = url.searchParams.get("action") || "state";
    if (action === "state") {
      const settings = await getSettings(s);
      const now = zoned().month, month = validMonth(url.searchParams.get("month"));
      const cur = await listOrders(s, `o/${now}/`, users);
      const res = { me: publicMe(me), settings, month_cans: cur.reduce((a, o) => a + o.cans, 0), server_month: now };
      if (me) {
        res.users = members(users);
        res.orders = month === now ? cur : await listOrders(s, `o/${month}/`, users);
        if (url.searchParams.get("history") === "1" && me.role === "member") {
          res.history = (await listOrders(s, "o/", users)).filter(o => o.u === me.username);
        }
      } else {
        res.users = SHOW_NAMES_ON_LOGIN ? members(users) : [];
        res.orders = [];
      }
      return json(res);
    }
    if (action === "export") {
      if (!me || me.role !== "admin") return fail("Only the admin can do this.", 403);
      const month = validMonth(url.searchParams.get("month"));
      const settings = await getSettings(s), cur = settings.currency;
      const rows = (await listOrders(s, `o/${month}/`, users)).reverse();
      const sum = new Map();
      for (const r of rows) { const k = r.u || "name:" + r.name; const x = sum.get(k) || { name: r.name, cans: 0, times: 0, amount: 0 }; x.cans += r.cans; x.times++; x.amount += r.amount; sum.set(k, x); }
      const [y, m] = month.split("-").map(Number);
      const out = [[`Water can list - ${new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}`], [], ["Summary"], ["Name", "Total cans", "Times ordered", `Amount (${cur})`]];
      let tc = 0, ta = 0;
      for (const x of sum.values()) { out.push([x.name, x.cans, x.times, x.amount]); tc += x.cans; ta += x.amount; }
      out.push(["Total", tc, "", ta], [], ["All orders"], ["Date", "Time", "Name", "Cans", `Price per can (${cur})`, `Amount (${cur})`]);
      for (const r of rows) {
        const d = new Date(r.at);
        out.push([d.toLocaleDateString("en-GB", { timeZone: TIME_ZONE }), d.toLocaleTimeString("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }), r.name, r.cans, r.price, r.amount]);
      }
      return new Response("﻿" + out.map(r => r.map(csvCell).join(",")).join("\r\n"), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="water-cans-${month}.csv"`, "Cache-Control": "no-store" } });
    }
    return fail("Unknown request.", 404);
  }

  if (req.method !== "POST") return fail("Method not allowed.", 405);
  if (req.headers.get("x-requested-with") !== "fetch") return fail("Bad request.", 400); // blocks posts from other websites
  let body; try { body = await req.json(); } catch { return fail("Bad request."); }
  const action = body.action;
  const needAdmin = () => (!me ? fail("Please log in again.", 401) : me.role !== "admin" ? fail("Only the admin can do this.", 403) : null);

  switch (action) {
    case "login": {
      const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
      if (await tooManyFails(s, ip)) return fail("Too many wrong tries. Wait 10 minutes and try again.", 429);
      const u = users[cleanUser(body.username)];
      if (!u || !checkPassword(u, String(body.password || ""))) {
        await addFail(s, ip);
        await new Promise(r => setTimeout(r, 400));
        return fail("Wrong username or password.", 401);
      }
      if (!u.pass) { u.pass = hashPassword(String(body.password)); delete u.legacy; delete u.salt; await saveUsers(s, users); } // upgrade old passwords
      await s.delete(attemptKey(ip));
      return json({ me: publicMe(u) }, 200, { "Set-Cookie": await makeCookie(s, u, secure) });
    }
    case "logout":
      return json({}, 200, { "Set-Cookie": clearCookie(secure) });

    case "add_order": {
      if (!me) return fail("Please log in again.", 401);
      if (me.role !== "member") return fail("Log in with a member account to add cans.", 403);
      const cans = Math.floor(Number(body.cans));
      if (!(cans >= 1 && cans <= 20)) return fail("Choose between 1 and 20 cans.");
      const { price } = await getSettings(s);
      const at = new Date().toISOString();
      const key = orderKey({ month: zoned().month, at, username: me.username, cans, price, name: me.name });
      await s.set(key, "1");
      return json({ id: key });
    }
    case "delete_order": {
      const no = needAdmin(); if (no) return no;
      const id = String(body.id || "");
      if (!id.startsWith("o/")) return fail("Order not found.", 404);
      await s.delete(id);
      return json({});
    }
    case "clear_month": {
      const no = needAdmin(); if (no) return no;
      const { blobs } = await s.list({ prefix: `o/${validMonth(body.month)}/` });
      for (const b of blobs) await s.delete(b.key);
      return json({ deleted: blobs.length });
    }
    case "save_settings": {
      const no = needAdmin(); if (no) return no;
      const settings = { hostel: cleanName(body.hostel), currency: String(body.currency || "Rs").trim().slice(0, 5) || "Rs",
                         price: Math.round(Math.max(0, Number(body.price) || 0) * 100) / 100 };
      await s.setJSON("settings", settings);
      return json({ settings });
    }
    case "add_user": {
      const no = needAdmin(); if (no) return no;
      const name = cleanName(body.name), username = cleanUser(body.username), pw = String(body.password || "");
      if (!name) return fail("Enter a name.");
      if (!/^[a-z0-9._-]{3,20}$/.test(username)) return fail("Username: 3–20 letters or numbers, no spaces.");
      if (pw.length < 4) return fail("Password must be at least 4 characters.");
      if (users[username] || username === "admin234") return fail("This username is already taken.");
      if (Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase())) return fail("A user with this name already exists.");
      const order = Math.max(0, ...Object.values(users).map(u => u.order || 0)) + 1;
      users[username] = { username, name, role: "member", pass: hashPassword(pw), order, created: new Date().toISOString() };
      await saveUsers(s, users);
      return json({});
    }
    case "rename_user": {
      const no = needAdmin(); if (no) return no;
      const username = cleanUser(body.username), name = cleanName(body.name);
      const u = users[username];
      if (!u || u.role !== "member") return fail("User not found.", 404);
      if (!name) return fail("Enter a name.");
      if (Object.values(users).some(x => x.username !== username && x.name.toLowerCase() === name.toLowerCase())) return fail("A user with this name already exists.");
      u.name = name; await saveUsers(s, users);
      return json({});
    }
    case "remove_user": {
      const no = needAdmin(); if (no) return no;
      const username = cleanUser(body.username), u = users[username];
      if (!u || u.role !== "member") return fail("User not found.", 404);
      // Old orders keep the name: re-save this person's orders without the account link.
      const { blobs } = await s.list({ prefix: "o/" });
      for (const b of blobs) {
        const o = parseOrder(b.key, users);
        if (o.u === username) { await s.set(orderKey({ month: o.month, at: o.at, username: "-", cans: o.cans, price: o.price, name: u.name, rand: b.key.split("/")[2].split("~")[0].split("_")[1] }), "1"); await s.delete(b.key); }
      }
      delete users[username]; await saveUsers(s, users);
      return json({});
    }
    case "set_password": {
      const no = needAdmin(); if (no) return no;
      const username = cleanUser(body.username), pw = String(body.password || ""), u = users[username];
      if (!u) return fail("User not found.", 404);
      if (pw.length < 4) return fail("Password must be at least 4 characters.");
      u.pass = hashPassword(pw); delete u.legacy; delete u.salt; await saveUsers(s, users);
      // The admin stays logged in after changing their own password; everyone else is logged out.
      return json({}, 200, username === me.username ? { "Set-Cookie": await makeCookie(s, u, secure) } : {});
    }
    default:
      return fail("Unknown action.", 404);
  }
};
