// scrape_html.js

const path = require("path");
const dotenv = require("dotenv");

// ✅ Carga .env desde CWD y también desde la carpeta del script (por si ejecutas desde otra ruta)
dotenv.config();
dotenv.config({ path: path.join(__dirname, ".env") });

const fs = require("fs-extra");
const puppeteer = require("puppeteer");
const readline = require("readline");
const XLSX = require("xlsx"); // ✅ Excel masivo

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

// Normaliza texto (quita tildes, espacios, lower)
function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* ✅ BOOL ROBUSTO (acepta true/false y también 0/1, "0"/"1")                  */
/* -------------------------------------------------------------------------- */
function toBool(v) {
  if (typeof v === "boolean") return v;

  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
    return undefined;
  }

  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "t", "yes", "y", "si", "s", "on"].includes(s)) return true;
    if (["0", "false", "f", "no", "n", "off"].includes(s)) return false;
    return undefined;
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/* ✅ BASE DIR (CAMBIO PEDIDO)                                                 */
/* -------------------------------------------------------------------------- */

const ROOT_CWD = process.cwd(); // raíz del proyecto
const JOB_BASE_DIR = process.env.JOB_OUTPUT_DIR ? path.resolve(process.env.JOB_OUTPUT_DIR) : ROOT_CWD;
const HTML_DIR_NAME = String(process.env.HTML_DIR_NAME || "HTML");

/* -------------------------------------------------------------------------- */
/* ✅ PATH RESOLVE ROBUSTO (FIX: usa webapp/permisos_campossap correctamente)  */
/* -------------------------------------------------------------------------- */

function cleanEnvPath(p) {
  return String(p || "").trim().replace(/^["']|["']$/g, ""); // quita comillas
}

function resolveMaybeRelative(p, base = ROOT_CWD) {
  const v = cleanEnvPath(p);
  if (!v) return null;
  return path.isAbsolute(v) ? v : path.resolve(base, v);
}

function chooseFirstExistingDir(candidates) {
  for (const d of candidates) {
    try {
      if (d && fs.existsSync(d)) return d;
    } catch {}
  }
  // si ninguno existe, devuelve el primero (se creará con ensureDir)
  return candidates[0];
}

/**
 * Resuelve un DIR:
 * - Si viene env => respeta (absoluto o relativo a ROOT_CWD)
 * - Si no => usa default (prioriza webapp si existe)
 */
function resolveDir(envKey, defaultCandidates) {
  const fromEnv = resolveMaybeRelative(process.env[envKey], ROOT_CWD);
  if (fromEnv) return fromEnv;
  return chooseFirstExistingDir(defaultCandidates);
}

/**
 * Resuelve un FILE PATH:
 * - Si envFile tiene separadores (/, \) => lo trata como ruta y respeta (relativa a ROOT_CWD o absoluta)
 * - Si envFile es solo nombre => lo une con dirBase
 * - Si no hay envFile => usa fallbackName en dirBase
 */
function resolveFilePath(envFile, dirBase, fallbackName) {
  const raw = cleanEnvPath(envFile);
  if (!raw) return path.join(dirBase, fallbackName);

  const looksLikePath = raw.includes("/") || raw.includes("\\");
  if (looksLikePath) {
    return resolveMaybeRelative(raw, ROOT_CWD);
  }
  return path.join(dirBase, path.basename(raw));
}

/* -------------------------------------------------------------------------- */
/* ✅ AUTO-PICK TEMPLATE JSON (si existe con otro nombre)                      */
/* -------------------------------------------------------------------------- */
function pickJsonTemplate(primaryPath, dirBase, extraCandidates = []) {
  try {
    if (primaryPath && fs.existsSync(primaryPath)) return primaryPath;
  } catch {}

  for (const cand of (extraCandidates || []).filter(Boolean)) {
    const p = path.isAbsolute(cand) ? cand : path.join(dirBase, cand);
    try {
      if (fs.existsSync(p)) {
        console.log(`✅ Template encontrado por candidato: ${p}`);
        return p;
      }
    } catch {}
  }

  try {
    if (dirBase && fs.existsSync(dirBase)) {
      const files = fs.readdirSync(dirBase).filter((f) => f.toLowerCase().endsWith(".json"));
      if (files.length === 1) {
        const p = path.join(dirBase, files[0]);
        console.log(`✅ Template encontrado (único JSON en carpeta): ${p}`);
        return p;
      }
    }
  } catch {}

  return primaryPath;
}

/* -------------------------------------------------------------------------- */
/* ✅ LOGGING (archivo + consola filtrada)                                     */
/* -------------------------------------------------------------------------- */

const RUN_ID = ts();

// LOG_DIR puede ser absoluto o relativo
const LOG_DIR_ENV = String(process.env.LOG_DIR || "LOGS");
const LOG_DIR = path.isAbsolute(LOG_DIR_ENV) ? LOG_DIR_ENV : path.join(JOB_BASE_DIR, LOG_DIR_ENV);

const RUN_LOG_DIR = path.join(LOG_DIR, `run_${RUN_ID}`);
const LOG_FILE = path.join(RUN_LOG_DIR, "run.log");

const CONSOLE_LEVEL = String(process.env.CONSOLE_LEVEL || "important").toLowerCase(); // important|warn|error|info|debug
const LEVELS = { debug: 10, info: 20, important: 30, warn: 40, error: 50 };

const ORIG_CONSOLE = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function redactSecrets(text) {
  const s = String(text ?? "");
  return s
    .replace(/(LOGIN_PASS\s*=\s*)(.+)/gi, "$1***")
    .replace(/(NEW_USER_PASS\s*=\s*)(.+)/gi, "$1***")
    .replace(/("LOGIN_PASS"\s*:\s*")([^"]+)(")/gi, '$1***$3')
    .replace(/("NEW_USER_PASS"\s*:\s*")([^"]+)(")/gi, '$1***$3');
}

async function logToFile(line) {
  await fs.ensureDir(RUN_LOG_DIR);
  await fs.appendFile(LOG_FILE, line + "\n", "utf8");
}

function shouldPrint(level) {
  const want = LEVELS[CONSOLE_LEVEL] ?? LEVELS.important;
  const got = LEVELS[level] ?? LEVELS.info;
  return got >= want;
}

function log(level, msg, extra) {
  const stamp = new Date().toISOString();
  const base = `[${stamp}] [${level.toUpperCase()}] ${redactSecrets(msg)}`;
  const line = extra ? `${base} | ${redactSecrets(JSON.stringify(extra))}` : base;

  // Siempre a archivo
  logToFile(line).catch(() => {});

  // A consola solo si corresponde
  if (shouldPrint(level)) {
    if (level === "warn") ORIG_CONSOLE.warn(base);
    else if (level === "error") ORIG_CONSOLE.error(base);
    else ORIG_CONSOLE.log(base);
  }
}

// Captura console.log/warn/error del script (todo a archivo, consola filtrada)
console.log = (...a) => log("info", a.map(String).join(" "));
console.warn = (...a) => log("warn", a.map(String).join(" "));
console.error = (...a) => log("error", a.map(String).join(" "));

function important(msg, extra) {
  log("important", msg, extra);
}

/* -------------------------------------------------------------------------- */
/* ✅ EXCEL MASIVO                                                             */
/* -------------------------------------------------------------------------- */

function readUsersFromExcel(excelPath) {
  const full = path.isAbsolute(excelPath) ? excelPath : path.join(process.cwd(), excelPath);
  if (!fs.existsSync(full)) throw new Error(`No existe Excel: ${full}`);

  const wb = XLSX.readFile(full, { cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  // Espera headers EXACTOS como variables env:
  const keys = [
    "NEW_USER_SUCURSAL",
    "NEW_USER_CODE",
    "NEW_USER_NAME",
    "NEW_USER_EMAIL",
    "NEW_USER_PASS",
    "NEW_USER_TIPO",
    "NEW_USER_COUNTER_ROL",
  ];

  const users = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const u = {};
    for (const k of keys) u[k] = String(r[k] ?? "").trim();

    const ok =
      u.NEW_USER_SUCURSAL &&
      u.NEW_USER_CODE &&
      u.NEW_USER_NAME &&
      u.NEW_USER_EMAIL &&
      u.NEW_USER_PASS &&
      u.NEW_USER_TIPO;

    if (!ok) continue; // ignora filas incompletas/vacías

    users.push({ index: i + 2, ...u }); // +2 por header y 1-based
  }

  return { users, excelFullPath: full, sheetName, totalRows: rows.length };
}

/* -------------------------------------------------------------------------- */
/* ✅ HELPERS AUTOCOMPLETE                                                     */
/* -------------------------------------------------------------------------- */

function tokensOf(s) {
  return norm(s).split(" ").filter(Boolean);
}

function valueMatchesAllTokens(value, wanted) {
  const v = norm(value);
  const toks = tokensOf(wanted);
  return toks.every((t) => v.includes(t));
}

function buildAutocompleteQuery(wantedRaw) {
  const toks = tokensOf(wantedRaw);
  if (toks.length <= 1) return wantedRaw;

  const stop = new Set(["zonal", "planta", "localidad", "sucursal"]);
  const filtered = toks.filter((t) => !stop.has(t));
  if (filtered.length) return filtered.join(" ");
  return toks.slice(-2).join(" ");
}

// Click por texto (robusto para SPA / botones sin id)
async function clickByText(page, text, { timeout = 30000 } = {}) {
  const wanted = norm(text);

  await page.waitForFunction(
    (wanted) => {
      const norm2 = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const candidates = Array.from(
        document.querySelectorAll('button, a, [role="button"], span[routerlink], [onclick], .btn')
      );

      return candidates.some((el) => norm2(el.innerText || el.textContent).includes(wanted));
    },
    { timeout },
    wanted
  );

  await page.evaluate((wanted) => {
    const norm2 = (s) =>
      String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"], span[routerlink], [onclick], .btn')
    );

    const el = candidates.find((e) => norm2(e.innerText || e.textContent).includes(wanted));
    if (!el) throw new Error("No encontrado por texto: " + wanted);

    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, wanted);
}

/**
 * Snapshot
 */
async function snapshot(page, outDir, prefix, { maxWidth = 2400 } = {}) {
  const stamp = ts();
  await fs.ensureDir(outDir);

  try {
    await page.evaluate(() => {
      document.documentElement.style.overflowX = "visible";
      document.body.style.overflowX = "visible";
    });
  } catch {}

  try {
    const dims = await page.evaluate(() => {
      const de = document.documentElement;
      const b = document.body;
      const w = Math.max(de.scrollWidth || 0, b?.scrollWidth || 0, window.innerWidth || 0);
      const h = Math.max(de.scrollHeight || 0, b?.scrollHeight || 0, window.innerHeight || 0);
      return { w, h };
    });

    const vp = page.viewport() || { width: 1920, height: 1080, deviceScaleFactor: 1 };
    const targetW = Math.min(Math.max(dims.w, vp.width), maxWidth);
    const targetH = Math.max(vp.height, 900);

    if (vp.width !== targetW || vp.height !== targetH) {
      await page.setViewport({
        width: targetW,
        height: targetH,
        deviceScaleFactor: vp.deviceScaleFactor || 1,
      });
      await sleep(120);
    }
  } catch {}

  const html = await page.content();
  const htmlPath = path.join(outDir, `${prefix}_${stamp}.html`);
  const pngPath = path.join(outDir, `${prefix}_${stamp}.png`);
  await fs.writeFile(htmlPath, html, "utf8");
  await page.screenshot({ path: pngPath, fullPage: true });

  important(`📌 Snapshot: ${prefix}`, { html: htmlPath, png: pngPath });
}

/* -------------------------------------------------------------------------- */
/* SET VALUE ROBUSTO                                                          */
/* -------------------------------------------------------------------------- */

async function setInputValueNative(page, selector, value, { timeout = 15000 } = {}) {
  if (value === undefined || value === null) return;

  await page.waitForSelector(selector, { timeout });

  const ok = await page.evaluate(
    ({ selector, value }) => {
      const el = document.querySelector(selector);
      if (!el) return { ok: false, reason: "No existe selector" };

      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = desc && desc.set;

      el.focus();
      if (setter) setter.call(el, String(value));
      else el.value = String(value);

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));

      return { ok: true, now: el.value };
    },
    { selector, value }
  );

  if (!ok?.ok) {
    console.log(`⚠️ setInputValueNative fallo en ${selector}: ${ok?.reason || "sin detalle"}`);
  } else if (String(value) !== String(ok.now)) {
    console.log(`⚠️ Valor diferente en ${selector}. Deseado="${value}" / Actual="${ok.now}"`);
  }
}

async function typeSlow(page, selector, value, { delay = 25 } = {}) {
  if (!value) return;
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value, { delay });
}

/* -------------------------------------------------------------------------- */
/* FIX: NO ABRIR 2 VECES MODAL MÓDULOS                                         */
/* -------------------------------------------------------------------------- */

async function isBootstrapModalOpen(page, modalSelector) {
  return await page.evaluate((modalSelector) => {
    const m = document.querySelector(modalSelector);
    if (!m) return false;
    const isShown = m.classList.contains("show");
    const style = (m.getAttribute("style") || "").toLowerCase();
    const isDisplayed = style.includes("display: block");
    return isShown || isDisplayed;
  }, modalSelector);
}

/* -------------------------------------------------------------------------- */
/* MODAL "Crear usuario": Tipo usuario + Sucursal                              */
/* -------------------------------------------------------------------------- */

async function waitAdminUsersModalOpen(page, { timeout = 25000 } = {}) {
  await page.waitForFunction(() => {
    const m = document.querySelector("#adminUsersModal");
    if (!m) return false;
    return m.classList.contains("show");
  }, { timeout });
}

async function selectInAdminModalByLabel(page, labelIncludes, wantedTextOrValue, { timeout = 20000 } = {}) {
  const wantedNorm = norm(wantedTextOrValue);
  const labelNorm = norm(labelIncludes);

  await waitAdminUsersModalOpen(page, { timeout });

  const res = await page.evaluate(
    ({ labelNorm, wantedNorm, wantedRaw }) => {
      const modal = document.querySelector("#adminUsersModal");
      if (!modal || !modal.classList.contains("show"))
        return { ok: false, reason: "No hay #adminUsersModal visible" };

      const norm2 = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const groups = Array.from(modal.querySelectorAll(".form-group, .input-group, .mb-2, .mb-3"));
      const g = groups.find((x) => {
        const lab = x.querySelector("label, .input-group-prepend .input-group-text, .input-group-text");
        const sel = x.querySelector("select");
        return lab && sel && norm2(lab.textContent).includes(labelNorm);
      });

      if (!g) return { ok: false, reason: `No se encontró grupo con label ~ "${labelNorm}" en #adminUsersModal` };

      const sel = g.querySelector("select");
      if (!sel) return { ok: false, reason: "No hay select en el grupo" };

      const opts = Array.from(sel.querySelectorAll("option"));

      const wantedLooksValue =
        /^[0-9]+$/.test(String(wantedRaw).trim()) || opts.some((o) => String(o.value) === String(wantedRaw).trim());

      let match = null;

      if (wantedLooksValue) {
        match = opts.find((o) => String(o.value) === String(wantedRaw).trim());
      }
      if (!match) {
        match = opts.find((o) => norm2(o.textContent).includes(wantedNorm));
      }

      if (!match) {
        return {
          ok: false,
          reason: `No hay option que matchee value="${wantedRaw}" ni texto~"${wantedNorm}"`,
          available: opts.map((o) => ({ value: o.value, text: (o.textContent || "").trim() })).slice(0, 50),
        };
      }

      sel.focus();
      sel.value = match.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.dispatchEvent(new Event("blur", { bubbles: true }));

      return { ok: true, value: match.value, text: (match.textContent || "").trim() };
    },
    { labelNorm, wantedNorm, wantedRaw: wantedTextOrValue }
  );

  if (!res.ok) {
    console.log("⚠️ selectInAdminModalByLabel debug:", res.available ? res.available : "");
    throw new Error(res.reason || "No se pudo seleccionar en select");
  }

  return res;
}

/* -------------------------------------------------------------------------- */
/* ✅ NUEVO (ARREGLADO): COUNTER ROL                                           */
/* -------------------------------------------------------------------------- */

function isTipoRequiringCounterRol(tipoTextOrEnv) {
  const t = norm(tipoTextOrEnv || "");
  return t.includes("counter") || t.includes("admin") || t.includes("administrador");
}

async function selectCounterRolIfPresent(page, tipoRes, { timeout = 12000 } = {}) {
  const wantedRaw = (process.env.NEW_USER_COUNTER_ROL || "").trim();
  if (!wantedRaw) {
    console.log("ℹ️ NEW_USER_COUNTER_ROL vacío -> no selecciona Counter rol.");
    return;
  }

  const tipoText = tipoRes && tipoRes.text ? tipoRes.text : process.env.NEW_USER_TIPO || "";
  const required = isTipoRequiringCounterRol(tipoText);

  await waitAdminUsersModalOpen(page, { timeout: 25000 });

  if (required) {
    try {
      await page.waitForFunction(() => {
        const modal = document.querySelector("#adminUsersModal");
        if (!modal || !modal.classList.contains("show")) return false;

        const norm2 = (s) =>
          String(s || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
        };

        const groups = Array.from(modal.querySelectorAll(".form-group, .input-group, .mb-2, .mb-3"));
        const candidates = [];

        for (const g of groups) {
          const labEl = g.querySelector("label, .input-group-prepend .input-group-text, .input-group-text");
          const sel = g.querySelector("select");
          if (!labEl || !sel) continue;

          const lab = norm2(labEl.textContent);

          if (lab.includes("tipo") && lab.includes("usuario")) continue;

          const id = norm2(sel.id || "");
          const name = norm2(sel.getAttribute("name") || "");

          const looksRol =
            lab.includes("rol") ||
            lab.includes("caja") ||
            lab.includes("counter") ||
            id.includes("rol") ||
            id.includes("caja") ||
            id.includes("cash") ||
            id.includes("register") ||
            id.includes("counter") ||
            name.includes("rol") ||
            name.includes("caja") ||
            name.includes("cash") ||
            name.includes("register") ||
            name.includes("counter");

          if (!looksRol) continue;
          if (!isVisible(sel)) continue;

          const optTxt = Array.from(sel.querySelectorAll("option"))
            .map((o) => norm2(o.textContent))
            .join(" ");
          const looksTipo = optTxt.includes("branch") && optTxt.includes("counter") && optTxt.includes("admin");

          const scoreBase =
            (lab.includes("rol") ? 5 : 0) +
            (lab.includes("caja") ? 5 : 0) +
            (lab.includes("counter") ? 4 : 0) +
            (id.includes("rol") || name.includes("rol") ? 3 : 0) +
            (id.includes("cash") || name.includes("cash") || id.includes("register") || name.includes("register")
              ? 3
              : 0) +
            (looksTipo ? -100 : 0);

          candidates.push({ score: scoreBase });
        }

        if (!candidates.length) return false;

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].score > 0;
      }, { timeout });
    } catch {
      throw new Error("❌ Se esperaba 'Counter rol' (por ser COUNTER/ADMIN) pero no apareció el SELECT en el modal.");
    }
  }

  const res = await page.evaluate(({ wantedRaw }) => {
    const modal = document.querySelector("#adminUsersModal");
    if (!modal || !modal.classList.contains("show")) {
      return { ok: false, missing: true, reason: "No hay #adminUsersModal visible" };
    }

    const norm2 = (s) =>
      String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
    };

    modal.querySelectorAll('[data-autofill="counterrol"]').forEach((x) => x.removeAttribute("data-autofill"));

    const groups = Array.from(modal.querySelectorAll(".form-group, .input-group, .mb-2, .mb-3"));
    const candidates = [];

    for (const g of groups) {
      const labEl = g.querySelector("label, .input-group-prepend .input-group-text, .input-group-text");
      const sel = g.querySelector("select");
      if (!labEl || !sel) continue;

      const lab = norm2(labEl.textContent);

      if (lab.includes("tipo") && lab.includes("usuario")) continue;

      const id = norm2(sel.id || "");
      const name = norm2(sel.getAttribute("name") || "");
      if (!isVisible(sel)) continue;

      const looksRol =
        lab.includes("rol") ||
        lab.includes("caja") ||
        lab.includes("counter") ||
        id.includes("rol") ||
        id.includes("caja") ||
        id.includes("cash") ||
        id.includes("register") ||
        id.includes("counter") ||
        name.includes("rol") ||
        name.includes("caja") ||
        name.includes("cash") ||
        name.includes("register") ||
        name.includes("counter");

      if (!looksRol) continue;

      const optsTextJoined = Array.from(sel.querySelectorAll("option"))
        .map((o) => norm2(o.textContent))
        .join(" ");

      const looksTipo =
        optsTextJoined.includes("branch") && optsTextJoined.includes("counter") && optsTextJoined.includes("admin");
      let score =
        (lab.includes("rol") ? 5 : 0) +
        (lab.includes("caja") ? 5 : 0) +
        (lab.includes("counter") ? 4 : 0) +
        (id.includes("rol") || name.includes("rol") ? 3 : 0) +
        (id.includes("cash") || name.includes("cash") || id.includes("register") || name.includes("register")
          ? 3
          : 0) +
        (looksTipo ? -100 : 0);

      candidates.push({
        score,
        label: (labEl.textContent || "").replace(/\s+/g, " ").trim(),
        id: sel.id || "",
        name: sel.getAttribute("name") || "",
        sel,
      });
    }

    if (!candidates.length) return { ok: false, missing: true, reason: "No se encontró SELECT candidato para Counter rol" };

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score <= 0) {
      return { ok: false, missing: true, reason: "No se encontró SELECT válido de Counter rol (score<=0)" };
    }

    best.sel.setAttribute("data-autofill", "counterrol");

    const opts = Array.from(best.sel.querySelectorAll("option")).map((o) => ({
      value: String(o.value || "").trim(),
      text: (o.textContent || "").replace(/\s+/g, " ").trim(),
    }));

    const wanted = norm2(wantedRaw);
    const toks = wanted.split(" ").filter(Boolean);

    const isPlaceholder = (o) => {
      const t = norm2(o.text);
      const v = norm2(o.value);
      return t === "---" || v === "---" || t === "" || v === "";
    };

    const candidatesOpts = opts.filter((o) => !isPlaceholder(o));
    const tokenMatch = (s) => {
      const n = norm2(s);
      if (!n) return false;
      return toks.length ? toks.every((tk) => n.includes(tk)) : n.includes(wanted);
    };

    let match =
      candidatesOpts.find((o) => norm2(o.value) === wanted) ||
      candidatesOpts.find((o) => norm2(o.text) === wanted) ||
      candidatesOpts.find((o) => norm2(o.value).includes(wanted)) ||
      candidatesOpts.find((o) => norm2(o.text).includes(wanted)) ||
      candidatesOpts.find((o) => tokenMatch(o.text)) ||
      candidatesOpts.find((o) => tokenMatch(o.value));

    if (!match) {
      const wantsCaja = wanted.includes("caja");
      const wantsCash = wanted.includes("cash") || wanted.includes("register") || wanted.includes("caj");
      const altNeedles = new Set();

      if (wantsCaja) {
        altNeedles.add("cash");
        altNeedles.add("register");
      }
      if (wantsCash) {
        altNeedles.add("caja");
      }

      const altArr = Array.from(altNeedles);
      if (altArr.length) {
        match =
          candidatesOpts.find((o) => altArr.some((a) => norm2(o.text).includes(a))) ||
          candidatesOpts.find((o) => altArr.some((a) => norm2(o.value).includes(a))) ||
          null;
      }
    }

    if (!match) {
      return {
        ok: false,
        missing: false,
        reason: `No hay opción que matchee "${wantedRaw}"`,
        selectInfo: { label: best.label, id: best.id, name: best.name },
        available: opts.slice(0, 80),
      };
    }

    best.sel.focus();
    best.sel.value = match.value;
    best.sel.dispatchEvent(new Event("input", { bubbles: true }));
    best.sel.dispatchEvent(new Event("change", { bubbles: true }));
    best.sel.dispatchEvent(new Event("blur", { bubbles: true }));

    return {
      ok: true,
      value: match.value,
      text: match.text,
      selectInfo: { label: best.label, id: best.id, name: best.name },
    };
  }, { wantedRaw });

  try {
    await page.evaluate(() => {
      const modal = document.querySelector("#adminUsersModal");
      if (!modal) return;
      modal.querySelectorAll('[data-autofill="counterrol"]').forEach((x) => x.removeAttribute("data-autofill"));
    });
  } catch {}

  if (res.ok) {
    console.log(
      `✅ Counter rol: ${res.text} (value=${res.value}) | select="${res.selectInfo?.label}" id="${res.selectInfo?.id}"`
    );
    return;
  }

  if (res.missing) {
    if (required) throw new Error("❌ Counter rol era requerido pero no está disponible/visible.");
    console.log("ℹ️ Counter rol no aparece para este tipo de usuario (OK).");
    return;
  }

  console.log("⚠️ Counter rol SELECT usado:", res.selectInfo || {});
  console.log("⚠️ Opciones Counter rol disponibles:", res.available || []);
  throw new Error(res.reason || "No se pudo seleccionar Counter rol");
}

/* -------------------------------------------------------------------------- */
/* ✅ DEBUG/ENSURE SUCURSAL (VALIDACIÓN REAL, NO SOLO TEXTO)                   */
/* -------------------------------------------------------------------------- */

async function debugSucursalState(page) {
  return await page.evaluate(() => {
    const modal = document.querySelector("#adminUsersModal");
    if (!modal) return { ok: false, reason: "No existe #adminUsersModal" };

    const norm2 = (s) =>
      String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const groups = Array.from(modal.querySelectorAll(".input-group, .form-group, .mb-2, .mb-3"));
    const g = groups.find((x) => {
      const lab = x.querySelector("label, .input-group-prepend .input-group-text, .input-group-text");
      const inp = x.querySelector('input[type="text"]');
      return lab && inp && norm2(lab.textContent).includes("sucursal");
    });

    if (!g) return { ok: false, reason: "No encontré el grupo de Sucursal" };

    const inp = g.querySelector('input[type="text"]');
    const text = inp ? inp.value || "" : "";
    const classes = inp ? inp.className : "";
    const ariaInvalid = inp ? inp.getAttribute("aria-invalid") : null;

    const isInvalid =
      (inp && inp.classList.contains("ng-invalid")) ||
      (inp && inp.classList.contains("is-invalid")) ||
      ariaInvalid === "true" ||
      false;

    const feedback = g.querySelector(".invalid-feedback, .text-danger");
    const feedbackText = feedback ? (feedback.textContent || "").replace(/\s+/g, " ").trim() : null;

    return { ok: true, text, classes, ariaInvalid, isInvalid, feedbackText };
  });
}

function isSucursalFeedbackBlocking(st) {
  const fb = norm(st?.feedbackText || "");
  if (!fb) return false;
  return fb.includes("escoge") || fb.includes("sucursal");
}

async function waitSucursalCommitted(page, wantedRaw, { timeout = 6000 } = {}) {
  const wanted = String(wantedRaw || "").trim();
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const st = await debugSucursalState(page);

    if (
      st?.ok &&
      !st.isInvalid &&
      !isSucursalFeedbackBlocking(st) &&
      (wanted ? valueMatchesAllTokens(st.text, wanted) : true)
    ) {
      return st;
    }

    await sleep(180);
  }

  return null;
}

async function ensureSucursalCommittedBeforeCreate(page) {
  const st1 = await debugSucursalState(page);
  console.log("🧪 Estado Sucursal (antes de Crear):", JSON.stringify(st1));

  if (st1.ok && !st1.isInvalid && !isSucursalFeedbackBlocking(st1)) return;

  const wanted = (process.env.NEW_USER_SUCURSAL || process.env.NEW_USER_SUCURSAL_VALUE || "").trim();
  if (!wanted) throw new Error("No hay NEW_USER_SUCURSAL/NEW_USER_SUCURSAL_VALUE para reintentar commit");

  console.log("🔁 Reintentando commit REAL de Sucursal antes de Crear...");
  await setAutocompleteInAdminModalByLabel(page, "sucursal", wanted, { timeout: 25000 });

  const st2 = await debugSucursalState(page);
  console.log("🧪 Estado Sucursal (después de re-commit):", JSON.stringify(st2));

  if (st2.ok && (st2.isInvalid || isSucursalFeedbackBlocking(st2))) {
    throw new Error("❌ Sucursal sigue inválida. Se ve texto, pero el AUTOCOMPLETE no quedó seleccionado realmente.");
  }
}

/* -------------------------------------------------------------------------- */
/* ✅ AUTOCOMPLETE (POPUP REAL)                                                */
/* -------------------------------------------------------------------------- */

async function hardBlurActiveElement(page) {
  await page.evaluate(() => {
    const ae = document.activeElement;
    if (ae && typeof ae.blur === "function") ae.blur();
    try {
      ae && ae.dispatchEvent && ae.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch {}
    try {
      document.body && document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.body && document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.body && document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } catch {}
  });
}

async function waitForAnyTypeaheadPopup(page, inputSel, { timeout = 6000 } = {}) {
  await page.waitForFunction(
    (inputSel) => {
      const inp = document.querySelector(inputSel);
      if (!inp) return false;

      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      };

      const optionSel =
        "button, a, .dropdown-item, .list-group-item, li, [role='option'], .ng-option, mat-option, .mat-option";

      const popSel = [
        "ngb-typeahead-window",
        "typeahead-container",
        ".dropdown-menu.show",
        ".list-group",
        ".autocomplete-suggestions",
        ".autocomplete-items",
        "ul[role='listbox']",
        ".ng-dropdown-panel",
        ".mat-autocomplete-panel",
        ".cdk-overlay-container .mat-autocomplete-panel",
      ].join(",");

      const pops = Array.from(document.querySelectorAll(popSel)).filter(isVisible);
      if (!pops.length) return false;

      return pops.some((p) => p.querySelectorAll(optionSel).length > 0);
    },
    { timeout },
    inputSel
  );
}

async function markBestTypeaheadOption(page, inputSel, wantedRaw) {
  return await page.evaluate(({ inputSel, wantedRaw }) => {
    const norm2 = (s) =>
      String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const tokens = norm2(wantedRaw).split(" ").filter(Boolean);

    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };

    const inp = document.querySelector(inputSel);
    if (!inp) return { ok: false, reason: "No existe inputSel" };
    const inpRect = inp.getBoundingClientRect();

    document.querySelectorAll('[data-autofill="pick"]').forEach((x) => x.removeAttribute("data-autofill"));

    const optionSel =
      "button, a, .dropdown-item, .list-group-item, li, [role='option'], .ng-option, mat-option, .mat-option";

    const popSel = [
      "ngb-typeahead-window",
      "typeahead-container",
      ".dropdown-menu.show",
      ".list-group",
      ".autocomplete-suggestions",
      ".autocomplete-items",
      "ul[role='listbox']",
      ".ng-dropdown-panel",
      ".mat-autocomplete-panel",
      ".cdk-overlay-container .mat-autocomplete-panel",
    ].join(",");

    const pops = Array.from(document.querySelectorAll(popSel)).filter(isVisible);
    if (!pops.length) return { ok: false, reason: "No hay popup visible (popSel)" };

    const dist = (p) => {
      const r = p.getBoundingClientRect();
      const dy = Math.min(Math.abs(r.top - inpRect.bottom), Math.abs(r.bottom - inpRect.top));
      const dx = Math.abs(r.left - inpRect.left);
      return dy * 10 + dx;
    };

    pops.sort((a, b) => dist(a) - dist(b));
    const popup = pops[0];

    const nodes = Array.from(popup.querySelectorAll(optionSel))
      .filter(isVisible)
      .map((el) => {
        const raw = (el.innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .replace(/^[•·]\s*/g, "");
        const r = el.getBoundingClientRect();
        return { el, raw, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
      })
      .filter((x) => x.raw);

    const preview = nodes.slice(0, 25).map((n) => n.raw);

    if (!nodes.length) return { ok: false, reason: "Popup sin items visibles", preview };

    const score = (txt) => {
      const t = norm2(txt);
      if (!t) return 0;
      let s = 0;
      for (const tok of tokens) if (t.includes(tok)) s++;
      const full = norm2(wantedRaw);
      if (full && t.includes(full)) s += 3;
      if (full && t === full) s += 7;
      return s;
    };

    let best = null;
    let bestScore = -1;
    let bestIndex = -1;

    for (let i = 0; i < nodes.length; i++) {
      const sc = score(nodes[i].raw);
      if (sc > bestScore) {
        bestScore = sc;
        best = nodes[i];
        bestIndex = i;
      }
    }

    if (!best || bestScore <= 0) {
      return { ok: false, reason: "No hay match con tokens", preview };
    }

    best.el.scrollIntoView({ block: "center" });
    best.el.setAttribute("data-autofill", "pick");

    const cx = best.rect.x + best.rect.w / 2;
    const cy = best.rect.y + best.rect.h / 2;

    return { ok: true, picked: best.raw, index: bestIndex, bestScore, cx, cy, preview };
  }, { inputSel, wantedRaw });
}

async function keyboardPickTypeaheadIndex(page, inputSel, index) {
  await page.focus(inputSel);
  await sleep(80);

  await page.keyboard.press("ArrowDown");
  await sleep(80);

  for (let i = 0; i < index; i++) {
    await page.keyboard.press("ArrowDown");
    await sleep(60);
  }

  await page.keyboard.press("Enter");
  await sleep(220);

  await hardBlurActiveElement(page);
  await sleep(180);
}

/* -------------------------------------------------------------------------- */
/* ✅ AUTOCOMPLETE SUCURSAL (COMMIT REAL)                                      */
/* -------------------------------------------------------------------------- */

async function setAutocompleteInAdminModalByLabel(page, labelIncludes, wantedText, { timeout = 25000 } = {}) {
  const labelNorm = norm(labelIncludes);
  const wantedRaw = String(wantedText || "").trim();
  if (!wantedRaw) return;

  await waitAdminUsersModalOpen(page, { timeout });

  const found = await page.evaluate(({ labelNorm }) => {
    const modal = document.querySelector("#adminUsersModal");
    if (!modal || !modal.classList.contains("show")) return { ok: false, reason: "No hay #adminUsersModal visible" };

    const norm2 = (s) =>
      String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    modal.querySelectorAll('[data-autofill="target"]').forEach((x) => x.removeAttribute("data-autofill"));

    const groups = Array.from(modal.querySelectorAll(".input-group, .form-group, .mb-2, .mb-3"));

    const candidates = groups
      .map((x) => {
        const lab = x.querySelector("label, .input-group-prepend .input-group-text, .input-group-text");
        const inp = x.querySelector('input[type="text"]');
        if (!lab || !inp) return null;
        const lt = norm2(lab.textContent);
        if (!lt.includes(labelNorm)) return null;
        return { x, lt };
      })
      .filter(Boolean);

    if (!candidates.length) {
      return { ok: false, reason: `No se encontró grupo con label ~ "${labelNorm}" en #adminUsersModal` };
    }

    candidates.sort((a, b) => a.lt.length - b.lt.length);

    const g = candidates[0].x;
    const inp = g.querySelector('input[type="text"]');
    inp.setAttribute("data-autofill", "target");
    inp.focus();

    return { ok: true };
  }, { labelNorm });

  if (!found.ok) throw new Error(found.reason);

  const inputSel = '#adminUsersModal [data-autofill="target"]';
  await page.waitForSelector(inputSel, { timeout: 15000 });

  const tries = [buildAutocompleteQuery(wantedRaw), wantedRaw];

  const waitPopupMs = Number(process.env.AUTOCOMPLETE_WAIT_MS || 650);
  const popupTimeout = Number(process.env.AUTOCOMPLETE_POPUP_TIMEOUT_MS || 6500);

  try {
    for (let attempt = 0; attempt < tries.length; attempt++) {
      const query = tries[attempt];

      await page.click(inputSel, { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type(inputSel, query, { delay: 35 });
      await sleep(waitPopupMs);

      try {
        await waitForAnyTypeaheadPopup(page, inputSel, { timeout: popupTimeout });
      } catch {
        console.log("⚠️ No apareció popup (aún). Reintento con otro query si hay.");
      }

      const pick = await markBestTypeaheadOption(page, inputSel, wantedRaw);

      if (!pick.ok) {
        if (pick.preview?.length) {
          console.log("⚠️ Opciones visibles (preview):");
          pick.preview.forEach((x) => console.log("   -", x));
        }
        console.log(`⚠️ No pude elegir item (attempt ${attempt + 1}/${tries.length}): ${pick.reason}`);
        continue;
      }

      console.log(`🔎 Mejor opción detectada: "${pick.picked}" (score=${pick.bestScore}, index=${pick.index})`);

      // ✅ #1 MARK + click real
      try {
        await page.click('[data-autofill="pick"]', { delay: 25 });
        await sleep(220);
        await hardBlurActiveElement(page);

        const okSt = await waitSucursalCommitted(page, wantedRaw, { timeout: 6500 });
        if (okSt) {
          console.log(`✅ Sucursal COMMIT OK (MARK+click): "${okSt.text}"`);
          return;
        }

        const stA = await debugSucursalState(page);
        console.log("⚠️ MARK+click no confirmó. Estado:", JSON.stringify(stA));
      } catch (e) {
        console.log("⚠️ Falló page.click('[data-autofill=\"pick\"]'). Intento otros métodos.", e.message || e);
      }

      // ✅ #2 teclado
      try {
        await keyboardPickTypeaheadIndex(page, inputSel, Math.max(0, pick.index));
        const okSt2 = await waitSucursalCommitted(page, wantedRaw, { timeout: 6500 });
        if (okSt2) {
          console.log(`✅ Sucursal COMMIT OK (teclado index+enter): "${okSt2.text}"`);
          return;
        }

        const stB = await debugSucursalState(page);
        console.log("⚠️ Teclado index+enter no confirmó. Estado:", JSON.stringify(stB));
      } catch (e) {
        console.log("⚠️ Falló teclado index+enter:", e.message || e);
      }

      // ✅ #3 mouse coords
      try {
        await page.mouse.move(pick.cx, pick.cy, { steps: 8 });
        await page.mouse.down();
        await page.mouse.up();
        await sleep(220);
        await hardBlurActiveElement(page);

        const okSt3 = await waitSucursalCommitted(page, wantedRaw, { timeout: 6500 });
        if (okSt3) {
          console.log(`✅ Sucursal COMMIT OK (mouse coords): "${okSt3.text}"`);
          return;
        }

        const stC = await debugSucursalState(page);
        console.log("⚠️ Mouse coords no confirmó. Estado:", JSON.stringify(stC));
      } catch (e) {
        console.log("⚠️ Falló mouse coords:", e.message || e);
      }

      const stNow = await debugSucursalState(page);
      console.log(`⚠️ Intento ${attempt + 1}/${tries.length} falló. Valor ahora="${stNow?.text || ""}"`);
    }

    const stEnd = await debugSucursalState(page);
    throw new Error(`❌ No se pudo SELECCIONAR la sucursal "${wantedRaw}". Estado final: ` + JSON.stringify(stEnd));
  } finally {
    await page.evaluate(() => {
      const modal = document.querySelector("#adminUsersModal");
      if (!modal) return;
      const el = modal.querySelector('[data-autofill="target"]');
      if (el) el.removeAttribute("data-autofill");
      document.querySelectorAll('[data-autofill="pick"]').forEach((x) => x.removeAttribute("data-autofill"));
    });
  }
}

// Tipo usuario (por label) => SELECT
async function selectTipoUsuario(page) {
  const wanted = (process.env.NEW_USER_TIPO || "BRANCH").trim();
  const r = await selectInAdminModalByLabel(page, "tipo de usuario", wanted, { timeout: 25000 });
  console.log(`✅ Tipo de usuario: ${r.text} (value=${r.value})`);
  return r;
}

// ✅ Sucursal (AUTOCOMPLETE INPUT) => SELECCIÓN REAL
async function selectSucursal(page) {
  const textEnv = (process.env.NEW_USER_SUCURSAL || "").trim();
  const valueEnv = (process.env.NEW_USER_SUCURSAL_VALUE || "").trim();
  const wanted = textEnv || valueEnv;

  if (!wanted) {
    console.log("ℹ️ NEW_USER_SUCURSAL vacío -> no selecciona Sucursal.");
    return;
  }

  await setAutocompleteInAdminModalByLabel(page, "sucursal", wanted, { timeout: 25000 });
  const st = await debugSucursalState(page);
  console.log(`✅ Sucursal seleccionada (estado): ${JSON.stringify(st)}`);
}

// Forzar valor estable para código (por si el UI lo pisa)
async function forceStableValueInModal(page, selector, value, { tries = 6, waitMs = 220 } = {}) {
  for (let i = 1; i <= tries; i++) {
    await page.evaluate(({ selector, value }) => {
      const modal = document.querySelector("#adminUsersModal");
      if (!modal || !modal.classList.contains("show")) throw new Error("No hay #adminUsersModal visible");

      const el = modal.querySelector(selector);
      if (!el) throw new Error("No existe selector en modal: " + selector);

      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = desc && desc.set;

      el.focus();
      if (setter) setter.call(el, String(value));
      else el.value = String(value);

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }, { selector, value });

    await sleep(waitMs);

    const now = await page.evaluate((selector) => {
      const modal = document.querySelector("#adminUsersModal");
      const el = modal ? modal.querySelector(selector) : null;
      return el ? el.value || "" : null;
    }, selector);

    if (String(now) === String(value)) {
      console.log(`✅ Valor estable en ${selector}: ${now}`);
      return;
    }

    console.log(`⚠️ Intento ${i}/${tries}: ${selector} no quedó. Actual="${now}" Deseado="${value}"`);
    await sleep(150);
  }

  throw new Error(`No se pudo fijar valor estable en ${selector} = "${value}"`);
}

async function fillCreateUserFromEnv(page) {
  const CODE = (process.env.NEW_USER_CODE || "").trim();
  const NAME = (process.env.NEW_USER_NAME || "").trim();
  const EMAIL = (process.env.NEW_USER_EMAIL || "").trim();
  const PASS = (process.env.NEW_USER_PASS || "").trim();

  await waitAdminUsersModalOpen(page, { timeout: 30000 });

  // 1) Tipo usuario (SELECT)
  const tipoRes = await selectTipoUsuario(page);

  // ✅ Counter rol (solo si aparece / requerido en COUNTER|ADMIN)
  await sleep(350);
  await selectCounterRolIfPresent(page, tipoRes);

  // 2) Sucursal (AUTOCOMPLETE)
  await selectSucursal(page);

  await sleep(350);

  // 3) Nombre / Correo
  if (NAME) await setInputValueNative(page, "#User_U_NAME", NAME);
  if (EMAIL) await setInputValueNative(page, "#User_E_Mail", EMAIL);

  // 4) Código
  if (CODE) await forceStableValueInModal(page, "#User_USER_CODE", CODE);

  // 5) Contraseñas
  if (PASS) {
    const done = await page.evaluate((PASS) => {
      const modal = document.querySelector("#adminUsersModal");
      if (!modal || !modal.classList.contains("show")) return { ok: false, reason: "No hay #adminUsersModal" };

      const norm2 = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const groups = Array.from(modal.querySelectorAll(".input-group, .form-group"));
      const passGroups = groups.filter((g) => {
        const lab = g.querySelector("label, .input-group-prepend .input-group-text, .input-group-text");
        const inp = g.querySelector("input");
        return lab && inp && norm2(lab.textContent).includes("contrasena");
      });

      const proto = HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = desc && desc.set;

      let count = 0;
      for (const g of passGroups) {
        const inp = g.querySelector("input");
        if (!inp) continue;
        inp.focus();
        if (setter) setter.call(inp, PASS);
        else inp.value = PASS;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        count++;
      }

      return { ok: true, count };
    }, PASS);

    if (!done.ok) throw new Error(done.reason || "No se pudo setear contraseñas");
    console.log(`✅ Contraseñas seteadas en ${done.count} input(s)`);
  } else {
    console.log("ℹ️ NEW_USER_PASS vacío -> no se setea contraseña.");
  }

  const st = await debugSucursalState(page);
  console.log("🧪 Estado Sucursal (post fill): " + JSON.stringify(st));

  console.log("✅ Modal Crear usuario llenado (Tipo SELECT + Counter rol + Sucursal AUTOCOMPLETE REAL + Código estable).");
}

/* -------------------------------------------------------------------------- */
/* ✅ NUEVO FIX REAL CAMPOS: activar tab por CONTENEDOR (NO POR TEXTO)         */
/* -------------------------------------------------------------------------- */

async function waitCamposContainerReady(page, containerSelector, { timeout = 25000, minCheckboxes = 2 } = {}) {
  await waitAdminUsersModalOpen(page, { timeout: Math.min(timeout, 25000) });

  await page.waitForFunction(
    ({ containerSelector, minCheckboxes }) => {
      const modal = document.querySelector("#adminUsersModal.show") || document.querySelector("#adminUsersModal");
      const el = (modal && modal.querySelector(containerSelector)) || document.querySelector(containerSelector);
      if (!el) return false;

      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const visible =
        r.width > 5 && r.height > 5 && st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";

      const cbs = el.querySelectorAll(
        'input[type="checkbox"][name^="show_"], input[type="checkbox"][name^="edit_"]'
      );

      return visible && cbs.length >= minCheckboxes;
    },
    { timeout },
    { containerSelector, minCheckboxes }
  );
}

async function activateTabForContainer(page, containerSelector, { timeout = 30000, minCheckboxes = 2 } = {}) {
  await waitAdminUsersModalOpen(page, { timeout: Math.min(timeout, 25000) });

  const info = await page.evaluate((containerSelector) => {
    const modal = document.querySelector("#adminUsersModal.show") || document.querySelector("#adminUsersModal");
    if (!modal) return { ok: false, reason: "No existe #adminUsersModal" };

    const container = modal.querySelector(containerSelector);
    if (!container) return { ok: false, reason: `No existe container dentro del modal: ${containerSelector}` };

    const pane = container.closest(".tab-pane,[role='tabpanel']");
    if (!pane) {
      return { ok: true, clicked: false, paneId: null, note: "Container no está dentro de tab-pane" };
    }

    const paneId = pane.getAttribute("id");
    if (!paneId) {
      return { ok: true, clicked: false, paneId: null, note: "tab-pane sin id" };
    }

    const isActive = pane.classList.contains("active") || pane.classList.contains("show");
    if (isActive) return { ok: true, clicked: false, paneId, note: "Pane ya activo" };

    const sel = `a[href="#${CSS.escape(paneId)}"], a[data-toggle="tab"][href="#${CSS.escape(
      paneId
    )}"], a[role="tab"][href="#${CSS.escape(paneId)}"], a[data-target="#${CSS.escape(
      paneId
    )}"], a[data-bs-target="#${CSS.escape(paneId)}"]`;

    const link = modal.querySelector(sel);
    if (!link) {
      const link2 = document.querySelector(sel);
      if (!link2) return { ok: false, reason: `No se encontró link de TAB para pane #${paneId}` };
      link2.scrollIntoView({ block: "center", inline: "center" });
      try {
        link2.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        link2.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        link2.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        link2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        link2.click();
      } catch {}
      return { ok: true, clicked: true, paneId, note: "Click en link global" };
    }

    link.scrollIntoView({ block: "center", inline: "center" });
    try {
      link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      link.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      link.click();
    } catch {}

    return { ok: true, clicked: true, paneId, note: "Click en link dentro modal" };
  }, containerSelector);

  if (!info.ok) throw new Error(info.reason || "No se pudo activar tab por contenedor");

  if (info.clicked) await sleep(450);

  await waitCamposContainerReady(page, containerSelector, { timeout, minCheckboxes });
}

/* -------------------------------------------------------------------------- */
/* FIX: CLICK GUARDAR MÁS RÁPIDO (MEJORADO PARA CAMPOS)                        */
/* -------------------------------------------------------------------------- */

async function clickButtonInContainerByText(page, containerSelector, textWanted, { timeout = 12000 } = {}) {
  return await clickButtonInContainerByAnyText(page, containerSelector, [textWanted], { timeout });
}

async function clickButtonInContainerByAnyText(page, containerSelector, textsWanted, { timeout = 12000 } = {}) {
  const wantedArr = (Array.isArray(textsWanted) ? textsWanted : [textsWanted]).map(norm).filter(Boolean);
  if (!wantedArr.length) throw new Error("textsWanted vacío");

  const started = Date.now();

  while (Date.now() - started < timeout) {
    const res = await page.evaluate(({ containerSelector, wantedArr }) => {
      const modal = document.querySelector("#adminUsersModal.show") || document.querySelector("#adminUsersModal");
      const container = (modal && modal.querySelector(containerSelector)) || document.querySelector(containerSelector);
      if (!container) return { ok: false, reason: "No existe container" };

      const norm2 = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const isDisabled = (el) => {
        if (!el) return true;
        const aria = el.getAttribute && el.getAttribute("aria-disabled");
        const cls = (el.className || "").toString();
        return !!el.disabled || aria === "true" || cls.includes("disabled");
      };

      const getText = (el) => {
        if (!el) return "";
        if (el.tagName === "INPUT") return el.value || el.getAttribute("value") || "";
        return el.innerText || el.textContent || "";
      };

      const candidates = Array.from(
        container.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")
      );

      let picked = null;

      for (const w of wantedArr) {
        picked = candidates.find((b) => norm2(getText(b)).includes(w) && !isDisabled(b));
        if (picked) break;
      }

      if (!picked) {
        for (const w of wantedArr) {
          const any = candidates.find((b) => norm2(getText(b)).includes(w));
          if (any) {
            return { ok: false, reason: "Botón encontrado pero está deshabilitado", foundText: getText(any) };
          }
        }
        return { ok: false, reason: "No existe botón aún" };
      }

      picked.scrollIntoView({ block: "center", inline: "center" });

      picked.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      picked.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      picked.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      picked.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      try {
        picked.click();
      } catch {}

      return { ok: true, clickedText: getText(picked) };
    }, { containerSelector, wantedArr });

    if (res.ok) {
      console.log(`✅ Click botón OK en ${containerSelector}: "${res.clickedText}"`);
      return;
    }

    if (res.reason && res.reason.includes("deshabilitado")) {
      console.log(`⚠️ Botón encontrado pero deshabilitado en ${containerSelector}: "${res.foundText || ""}"`);
    }

    await sleep(220);
  }

  console.log(`⚠️ No se pudo click dentro de ${containerSelector}. Intento fallback en #adminUsersModal...`);
  await clickButtonInModalByAnyText(page, "#adminUsersModal", textsWanted, { timeout: Math.min(9000, timeout) });
}

async function clickButtonInModalByAnyText(page, modalSelector, textsWanted, { timeout = 9000 } = {}) {
  const wantedArr = (Array.isArray(textsWanted) ? textsWanted : [textsWanted]).map(norm).filter(Boolean);
  if (!wantedArr.length) throw new Error("textsWanted vacío");

  const started = Date.now();
  while (Date.now() - started < timeout) {
    const res = await page.evaluate(({ modalSelector, wantedArr }) => {
      const modal = document.querySelector(modalSelector);
      if (!modal) return { ok: false, reason: "No existe modal" };

      const norm2 = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
      };

      const isDisabled = (el) => {
        if (!el) return true;
        const aria = el.getAttribute && el.getAttribute("aria-disabled");
        const cls = (el.className || "").toString();
        return !!el.disabled || aria === "true" || cls.includes("disabled");
      };

      const getText = (el) => {
        if (!el) return "";
        if (el.tagName === "INPUT") return el.value || el.getAttribute("value") || "";
        return el.innerText || el.textContent || "";
      };

      const candidates = Array.from(
        modal.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")
      ).filter(isVisible);

      let picked = null;
      for (const w of wantedArr) {
        picked = candidates.find((b) => norm2(getText(b)).includes(w) && !isDisabled(b));
        if (picked) break;
      }
      if (!picked) return { ok: false, reason: "No encontrado aún" };

      picked.scrollIntoView({ block: "center", inline: "center" });
      picked.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      picked.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      picked.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      picked.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      try {
        picked.click();
      } catch {}

      return { ok: true, clickedText: getText(picked) };
    }, { modalSelector, wantedArr });

    if (res.ok) {
      console.log(`✅ Click fallback modal OK: "${res.clickedText}"`);
      return;
    }

    await sleep(240);
  }

  throw new Error(`No se pudo clickear ningún botón con textos=${JSON.stringify(textsWanted)} en modal ${modalSelector}`);
}

/* -------------------------------------------------------------------------- */
/* ✅ UTIL: Abrir modal "Crear usuario" (para masivo)                          */
/* -------------------------------------------------------------------------- */

async function openCrearUsuarioModal(page) {
  const crearBtnSel = "button.btn.btn-outline-secondary.btn-timbra-one.mr-sm-3";
  try {
    await page.waitForSelector(crearBtnSel, { timeout: 15000 });
    await page.click(crearBtnSel);
  } catch {
    await clickByText(page, "Crear usuario", { timeout: 20000 });
  }
  await sleep(900);
  await waitAdminUsersModalOpen(page, { timeout: 25000 });
}

/* -------------------------------------------------------------------------- */
/* CREAR (botón final)                                                        */
/* -------------------------------------------------------------------------- */

async function clickCrearUsuarioSiCorresponde(page) {
  const AUTO_CREATE = String(process.env.AUTO_CREATE || "false").toLowerCase() === "true";
  if (!AUTO_CREATE) {
    console.log("ℹ️ AUTO_CREATE=false -> NO se hace click en 'Crear'.");
    return { clicked: false };
  }

  await ensureSucursalCommittedBeforeCreate(page);

  await page.waitForFunction(() => {
    const modal = document.querySelector("#adminUsersModal") || document;
    const btn = Array.from(modal.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim().toLowerCase() === "crear"
    );
    return !!btn;
  }, { timeout: 20000 });

  await page.evaluate(() => {
    const modal = document.querySelector("#adminUsersModal") || document;
    const btn = Array.from(modal.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim().toLowerCase() === "crear"
    );
    if (!btn) throw new Error("No se encontró botón Crear");
    btn.scrollIntoView({ block: "center", inline: "center" });

    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    try { btn.click(); } catch {}
  });

  console.log("✅ Click en 'Crear' realizado (AUTO_CREATE=true).");
  return { clicked: true };
}

/* -------------------------------------------------------------------------- */
/* MÓDULOS (modal #modulesModal)                                               */
/* -------------------------------------------------------------------------- */

async function clickModulosButton(page, { timeout = 20000 } = {}) {
  if (await isBootstrapModalOpen(page, "#modulesModal")) {
    console.log("ℹ️ modulesModal ya está abierto -> no se vuelve a abrir.");
    return;
  }

  await page.waitForFunction(
    () => {
      const normalize = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const roots = Array.from(document.querySelectorAll(".modal.show"));
      const scope = roots.length ? roots : [document];

      for (const root of scope) {
        const groups = Array.from(root.querySelectorAll(".input-group.mb-3, .input-group"));
        for (const g of groups) {
          const label = g.querySelector(".input-group-prepend .input-group-text");
          const btn = g.querySelector('button[type="button"].input-group-text, button[type="button"]');
          const ico = btn ? btn.querySelector("i.fa.fa-list") : null;
          if (!label || !btn || !ico) continue;
          if (normalize(label.textContent).includes("modulos")) return true;
        }
      }
      return false;
    },
    { timeout }
  );

  const result = await page.evaluate(() => {
    const normalize = (s) =>
      String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const roots = Array.from(document.querySelectorAll(".modal.show"));
    const scope = roots.length ? roots : [document];

    for (const root of scope) {
      const groups = Array.from(root.querySelectorAll(".input-group.mb-3, .input-group"));
      for (const g of groups) {
        const label = g.querySelector(".input-group-prepend .input-group-text");
        const btn = g.querySelector('button[type="button"].input-group-text, button[type="button"]');
        const ico = btn ? btn.querySelector("i.fa.fa-list") : null;
        if (!label || !btn || !ico) continue;

        if (normalize(label.textContent).includes("modulos")) {
          btn.scrollIntoView({ block: "center", inline: "center" });

          const disabled =
            btn.disabled ||
            btn.getAttribute("aria-disabled") === "true" ||
            btn.classList.contains("disabled");

          if (disabled) return { ok: false, reason: "El botón de Módulos está deshabilitado" };

          btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

          return { ok: true };
        }
      }
    }
    return { ok: false, reason: "No se encontró el bloque de Módulos" };
  });

  if (!result.ok) throw new Error("No se pudo clickear Módulos: " + (result.reason || "sin detalle"));

  await page.waitForFunction(() => {
    const m = document.querySelector("#modulesModal");
    if (!m) return false;
    const isShown = m.classList.contains("show");
    const style = (m.getAttribute("style") || "").toLowerCase();
    const isDisplayed = style.includes("display: block");
    return isShown || isDisplayed;
  }, { timeout: 20000 });

  await page.waitForFunction(() => {
    const modal = document.querySelector("#modulesModal");
    if (!modal) return false;
    const rows = modal.querySelectorAll("tbody tr");
    return rows && rows.length > 0;
  }, { timeout: 20000 });
}

async function scrollModulesTableToBottom(page, { maxLoops = 30 } = {}) {
  for (let i = 0; i < maxLoops; i++) {
    const didMove = await page.evaluate(() => {
      const modal = document.querySelector("#modulesModal");
      if (!modal) return false;

      const scroller = modal.querySelector(".table-scroll") || modal.querySelector(".modal-body") || modal;
      const prev = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      return scroller.scrollTop !== prev;
    });

    await sleep(150);
    if (!didMove) break;
  }
}

async function extractModules(page) {
  return await page.evaluate(() => {
    const modal = document.querySelector("#modulesModal");
    if (!modal) throw new Error("No existe #modulesModal");

    const rows = Array.from(modal.querySelectorAll("tbody tr"));
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const out = [];
    for (const r of rows) {
      const tds = Array.from(r.querySelectorAll("td"));
      if (!tds.length) continue;

      const title = clean(tds[0]?.innerText || tds[0]?.textContent);
      const cbs = Array.from(r.querySelectorAll('input[type="checkbox"]'));
      const activo = cbs[0] ? !!cbs[0].checked : null;
      const escritura = cbs[1] ? !!cbs[1].checked : null;

      if (!title || title.toLowerCase() === "título" || title.toLowerCase() === "titulo") continue;
      out.push({ title, activo, escritura });
    }
    return out;
  });
}

/* ✅ FIX: también acepta 0/1 */
function normalizeTemplateToObject(templateAny) {
  if (templateAny && typeof templateAny === "object" && !Array.isArray(templateAny)) {
    const out = {};
    for (const [k, v] of Object.entries(templateAny)) {
      if (v && typeof v === "object") {
        out[k] = {
          activo: toBool(v.activo ?? v.active ?? v.enable),
          escritura: toBool(v.escritura ?? v.write ?? v.editar ?? v.edit),
        };
      }
    }
    return out;
  }

  if (Array.isArray(templateAny)) {
    const out = {};
    for (const item of templateAny) {
      if (!item) continue;
      const title = item.title || item.titulo || item.name;
      if (!title) continue;
      out[title] = {
        activo: toBool(item.activo ?? item.active ?? item.enable),
        escritura: toBool(item.escritura ?? item.write ?? item.editar ?? item.edit),
      };
    }
    return out;
  }

  return {};
}

async function applyModulesTemplate(page, templateObj) {
  return await page.evaluate((templateObj) => {
    const normalize = (s) =>
      String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const modal = document.querySelector("#modulesModal");
    if (!modal) throw new Error("No existe #modulesModal");

    const rows = Array.from(modal.querySelectorAll("tbody tr"));
    const logs = { touched: 0, notFound: [] };

    const byTitle = new Map();
    for (const r of rows) {
      const td0 = r.querySelector("td");
      if (!td0) continue;
      const title = td0.innerText || td0.textContent || "";
      const key = normalize(title);
      if (key) byTitle.set(key, r);
    }

    const fireMouse = (el) => {
      if (!el) return;
      try {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } catch {}
      try { el.click && el.click(); } catch {}
    };

    const setCheckbox = (cb, wanted) => {
      if (!cb || typeof wanted !== "boolean") return;
      if (!!cb.checked === wanted) return;

      cb.scrollIntoView({ block: "center", inline: "center" });

      // 1) click real
      fireMouse(cb);
      cb.dispatchEvent(new Event("change", { bubbles: true }));
      cb.dispatchEvent(new Event("input", { bubbles: true }));

      // 2) td/row click
      if (!!cb.checked !== wanted) {
        const td = cb.closest("td") || cb.parentElement;
        fireMouse(td);
      }

      // 3) programático
      if (!!cb.checked !== wanted) {
        cb.checked = wanted;
        cb.dispatchEvent(new Event("input", { bubbles: true }));
        cb.dispatchEvent(new Event("change", { bubbles: true }));
        cb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    };

    for (const [title, conf] of Object.entries(templateObj || {})) {
      const key = normalize(title);
      const row = byTitle.get(key);
      if (!row) {
        logs.notFound.push(title);
        continue;
      }

      const cbs = Array.from(row.querySelectorAll('input[type="checkbox"]'));
      setCheckbox(cbs[0], conf?.activo);
      setCheckbox(cbs[1], conf?.escritura);
      logs.touched++;
    }

    return logs;
  }, templateObj);
}

async function clickGuardarModulesModal(page, { timeout = 12000 } = {}) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const res = await page.evaluate(() => {
      const modal = document.querySelector("#modulesModal");
      if (!modal) return { ok: false, reason: "No existe #modulesModal" };

      const btn = Array.from(modal.querySelectorAll("button")).find(
        (b) => (b.textContent || "").trim().toLowerCase() === "guardar"
      );
      if (!btn) return { ok: false, reason: "No hay botón Guardar aún" };

      btn.scrollIntoView({ block: "center", inline: "center" });
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      try { btn.click(); } catch {}
      return { ok: true };
    });

    if (res.ok) {
      await sleep(Number(process.env.SAVE_WAIT_MS || 600));
      return;
    }

    await sleep(200);
  }

  throw new Error("No se pudo clickear Guardar en modulesModal (timeout corto).");
}

/* -------------------------------------------------------------------------- */
/* CAMPOS SAP + ARTÍCULOS (GENÉRICO)                                           */
/* -------------------------------------------------------------------------- */

async function extractCamposSAPGeneric(page, containerSelector) {
  return await page.evaluate((containerSelector) => {
    const modal = document.querySelector("#adminUsersModal.show") || document.querySelector("#adminUsersModal");
    const container = (modal && modal.querySelector(containerSelector)) || document.querySelector(containerSelector);
    if (!container) throw new Error(`No existe ${containerSelector}`);

    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const out = [];

    const tables = Array.from(container.querySelectorAll("table"));
    if (!tables.length) throw new Error(`No hay tablas dentro de ${containerSelector}`);

    for (const table of tables) {
      const tbody = table.querySelector("tbody");
      if (!tbody) continue;

      let group = null;
      const rows = Array.from(tbody.querySelectorAll("tr"));

      for (const r of rows) {
        const tds = Array.from(r.querySelectorAll("td"));
        if (!tds.length) continue;

        const cbs = Array.from(r.querySelectorAll('input[type="checkbox"]'));

        if (!cbs.length && tds.length === 1 && (tds[0].getAttribute("colspan") || "") === "3") {
          const header = clean(tds[0].innerText || tds[0].textContent);
          if (header) group = header;
          continue;
        }

        const label = clean(tds[0]?.innerText || tds[0]?.textContent);
        if (!label) continue;

        const showCb = r.querySelector('input[type="checkbox"][name^="show_"]');
        const editCb = r.querySelector('input[type="checkbox"][name^="edit_"]');

        const showName = showCb ? showCb.getAttribute("name") : null;
        const editName = editCb ? editCb.getAttribute("name") : null;

        const code =
          (showName && showName.replace(/^show_/, "")) ||
          (editName && editName.replace(/^edit_/, "")) ||
          null;

        out.push({
          code,
          group,
          label,
          mostrar: showCb ? !!showCb.checked : null,
          editar: editCb ? !!editCb.checked : null,
          showName,
          editName,
          container: containerSelector,
        });
      }
    }

    return out;
  }, containerSelector);
}

/* ✅ FIX: también acepta 0/1 */
function normalizeCamposTemplateToObject(templateAny) {
  if (templateAny && typeof templateAny === "object" && !Array.isArray(templateAny)) {
    const out = {};
    for (const [k, v] of Object.entries(templateAny)) {
      if (!v || typeof v !== "object") continue;
      out[k] = {
        mostrar: toBool(v.mostrar ?? v.show ?? v.visible ?? v.ver),
        editar: toBool(v.editar ?? v.edit ?? v.escritura),
      };
    }
    return out;
  }

  if (Array.isArray(templateAny)) {
    const out = {};
    for (const it of templateAny) {
      if (!it || typeof it !== "object") continue;
      const code = it.code || it.key || it.name;
      if (!code) continue;
      out[code] = {
        mostrar: toBool(it.mostrar ?? it.show ?? it.visible ?? it.ver),
        editar: toBool(it.editar ?? it.edit ?? it.escritura),
      };
    }
    return out;
  }

  return {};
}

/* -------------------------------------------------------------------------- */
/* ✅ FIX: APPLY CAMPOS "ANGULAR-PROOF" + CLICK TD/LABEL + eventos             */
/* -------------------------------------------------------------------------- */
async function applyCamposTemplateGeneric(page, containerSelector, templateObj) {
  return await page.evaluate((containerSelector, templateObj) => {
    const modal = document.querySelector("#adminUsersModal.show") || document.querySelector("#adminUsersModal");
    const container = (modal && modal.querySelector(containerSelector)) || document.querySelector(containerSelector);
    if (!container) throw new Error(`No existe ${containerSelector}`);

    const isDisabled = (el) => {
      if (!el) return true;
      const aria = el.getAttribute && el.getAttribute("aria-disabled");
      const cls = (el.className || "").toString();
      return !!el.disabled || aria === "true" || cls.includes("disabled");
    };

    const fireMouse = (el) => {
      if (!el) return;
      try {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } catch {}
      try { el.click && el.click(); } catch {}
    };

    const setCheckbox = (cb, wanted) => {
      if (!cb || typeof wanted !== "boolean") return;
      if (isDisabled(cb)) return;

      const current = !!cb.checked;
      if (current === wanted) return;

      cb.scrollIntoView({ block: "center", inline: "center" });

      // ✅ 1) click real
      fireMouse(cb);

      // ✅ 2) label asociado
      if (!!cb.checked !== wanted) {
        const id = cb.getAttribute("id");
        let lab = null;
        if (id) lab = container.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (!lab) lab = cb.closest("label");
        if (!lab) lab = cb.parentElement;
        fireMouse(lab);
      }

      // ✅ 3) td/celda
      if (!!cb.checked !== wanted) {
        const td = cb.closest("td") || cb.parentElement;
        fireMouse(td);
      }

      // ✅ 4) fallback programático + eventos
      if (!!cb.checked !== wanted) {
        cb.checked = wanted;
        cb.dispatchEvent(new Event("input", { bubbles: true }));
        cb.dispatchEvent(new Event("change", { bubbles: true }));
        cb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    };

    const inputs = Array.from(
      container.querySelectorAll('input[type="checkbox"][name^="show_"], input[type="checkbox"][name^="edit_"]')
    );

    const byCode = new Map();
    for (const cb of inputs) {
      const name = cb.getAttribute("name") || "";
      const isShow = name.startsWith("show_");
      const isEdit = name.startsWith("edit_");
      if (!isShow && !isEdit) continue;

      const code = name.replace(/^show_/, "").replace(/^edit_/, "");
      if (!code) continue;

      if (!byCode.has(code)) byCode.set(code, { showCb: null, editCb: null });
      const row = byCode.get(code);
      if (isShow) row.showCb = cb;
      if (isEdit) row.editCb = cb;
    }

    const logs = { touched: 0, notFound: [], totalCheckboxes: inputs.length };

    for (const [code, conf] of Object.entries(templateObj || {})) {
      const row = byCode.get(code);
      if (!row) {
        logs.notFound.push(code);
        continue;
      }
      setCheckbox(row.showCb, conf?.mostrar);
      setCheckbox(row.editCb, conf?.editar);
      logs.touched++;
    }

    return logs;
  }, containerSelector, templateObj);
}

/* ✅ VERIFY: para saber si quedó aplicado o no (mismatches) */
async function verifyCamposApplied(page, containerSelector, templateObj, { maxReport = 30 } = {}) {
  const res = await page.evaluate((containerSelector, templateObj, maxReport) => {
    const modal = document.querySelector("#adminUsersModal.show") || document.querySelector("#adminUsersModal");
    const container = (modal && modal.querySelector(containerSelector)) || document.querySelector(containerSelector);
    if (!container) return { ok: false, reason: `No existe ${containerSelector}` };

    const byCode = new Map();
    const inputs = Array.from(
      container.querySelectorAll('input[type="checkbox"][name^="show_"], input[type="checkbox"][name^="edit_"]')
    );
    for (const cb of inputs) {
      const name = cb.getAttribute("name") || "";
      const isShow = name.startsWith("show_");
      const isEdit = name.startsWith("edit_");
      if (!isShow && !isEdit) continue;

      const code = name.replace(/^show_/, "").replace(/^edit_/, "");
      if (!code) continue;

      if (!byCode.has(code)) byCode.set(code, { showCb: null, editCb: null });
      const row = byCode.get(code);
      if (isShow) row.showCb = cb;
      if (isEdit) row.editCb = cb;
    }

    const mismatches = [];
    for (const [code, conf] of Object.entries(templateObj || {})) {
      const row = byCode.get(code);
      if (!row) continue;

      if (typeof conf?.mostrar === "boolean" && row.showCb && !!row.showCb.checked !== conf.mostrar) {
        mismatches.push({ code, kind: "mostrar", wanted: conf.mostrar, now: !!row.showCb.checked });
      }
      if (typeof conf?.editar === "boolean" && row.editCb && !!row.editCb.checked !== conf.editar) {
        mismatches.push({ code, kind: "editar", wanted: conf.editar, now: !!row.editCb.checked });
      }
      if (mismatches.length >= maxReport) break;
    }

    return { ok: true, mismatchCount: mismatches.length, mismatches };
  }, containerSelector, templateObj, maxReport);

  return res;
}

/* -------------------------------------------------------------------------- */
/* ✅ BLOQUE COMPLETO para procesar 1 usuario                                  */
/* -------------------------------------------------------------------------- */

async function processOneUserFlow(page, { outDir, permisosPath, camposPath, AUTO_SAVE_CAMPOS } = {}) {
  // 1) Abrir modal Crear usuario
  await openCrearUsuarioModal(page);
  await snapshot(page, outDir, "crearUsuario");

  // 2) Llenar inputs + Tipo + CounterRol + Sucursal + Contraseñas
  await fillCreateUserFromEnv(page);
  await sleep(400);
  await snapshot(page, outDir, "crearUsuario_lleno");

  // ----------------------
  // ✅ MÓDULOS (SOLO 1 VEZ)
  // ----------------------
  await clickModulosButton(page, { timeout: 25000 });
  await sleep(500);

  await scrollModulesTableToBottom(page);
  await sleep(200);

  const modules = await extractModules(page);
  await fs.writeJson(path.join(outDir, `modules_catalog_${ts()}.json`), modules, { spaces: 2 });
  await fs.writeJson(path.join(outDir, `modules_catalog_latest.json`), modules, { spaces: 2 });
  console.log(`📦 Módulos detectados: ${modules.length}`);

  if (!(await fs.pathExists(permisosPath))) {
    const templateObj = {};
    for (const m of modules) {
      templateObj[m.title] = { activo: m.activo === true, escritura: m.escritura === true };
    }
    await fs.writeJson(permisosPath, templateObj, { spaces: 2 });
    console.log("✅ Se creó plantilla de MÓDULOS:", permisosPath);
    await snapshot(page, outDir, "modulos_template_creado");
  } else {
    const rawTemplate = await fs.readJson(permisosPath);
    const templateObj = normalizeTemplateToObject(rawTemplate);

    const logs = await applyModulesTemplate(page, templateObj);
    console.log(`🧩 MÓDULOS aplicados. Filas tocadas: ${logs.touched}`);
    if (logs.notFound?.length) {
      console.log("⚠️ MÓDULOS no encontrados:");
      logs.notFound.forEach((t) => console.log("   -", t));
    }

    await sleep(250);
    await snapshot(page, outDir, "modulos_aplicado");

    await clickGuardarModulesModal(page);
    await snapshot(page, outDir, "modulos_guardado");
  }

  // ----------------------
  // ✅ CAMPOS SAP + DATOS ARTÍCULOS + GUARDAR (FIX REAL: por contenedor)
  // ----------------------
  try {
    await activateTabForContainer(page, "#ModulosSociosDeNegocios", { timeout: 30000, minCheckboxes: 2 });
    const bpCatalog = await extractCamposSAPGeneric(page, "#ModulosSociosDeNegocios");

    await activateTabForContainer(page, "#ModulosArticulos", { timeout: 30000, minCheckboxes: 2 });
    const artCatalog = await extractCamposSAPGeneric(page, "#ModulosArticulos");

    const camposCatalog = [...bpCatalog, ...artCatalog];

    await fs.writeJson(path.join(outDir, `campos_sap_catalog_${ts()}.json`), camposCatalog, { spaces: 2 });
    await fs.writeJson(path.join(outDir, `campos_sap_catalog_latest.json`), camposCatalog, { spaces: 2 });
    console.log(`🧾 Campos SAP + Artículos detectados: ${camposCatalog.length}`);

    if (!(await fs.pathExists(camposPath))) {
      const templateObj = {};
      for (const c of camposCatalog) {
        if (!c.code) continue;
        templateObj[c.code] = {
          nombre: c.label,
          grupo: c.group,
          container: c.container,
          mostrar: c.mostrar === true,
          editar: c.editar === true,
        };
      }
      await fs.writeJson(camposPath, templateObj, { spaces: 2 });
      console.log("✅ Se creó plantilla de CAMPOS:", camposPath);
      await snapshot(page, outDir, "campos_template_creado");
    } else {
      const rawCampos = await fs.readJson(camposPath);
      const templateObj = normalizeCamposTemplateToObject(rawCampos);

      // ✅ aplicar en Socios
      await activateTabForContainer(page, "#ModulosSociosDeNegocios", { timeout: 30000, minCheckboxes: 2 });
      const logsBP = await applyCamposTemplateGeneric(page, "#ModulosSociosDeNegocios", templateObj);
      console.log(`🧩 CAMPOS SOCIOS aplicados. Filas tocadas: ${logsBP.touched} | checkboxes=${logsBP.totalCheckboxes}`);

      // ✅ aplicar en Artículos
      await activateTabForContainer(page, "#ModulosArticulos", { timeout: 30000, minCheckboxes: 2 });
      const logsART = await applyCamposTemplateGeneric(page, "#ModulosArticulos", templateObj);
      console.log(`🧩 DATOS ARTÍCULOS aplicados. Filas tocadas: ${logsART.touched} | checkboxes=${logsART.totalCheckboxes}`);

      // ✅ VERIFY (para ver si quedó realmente aplicado)
      await activateTabForContainer(page, "#ModulosSociosDeNegocios", { timeout: 30000, minCheckboxes: 2 });
      const v1 = await verifyCamposApplied(page, "#ModulosSociosDeNegocios", templateObj);
      console.log("🔍 VERIFY SOCIOS:", JSON.stringify(v1));

      await activateTabForContainer(page, "#ModulosArticulos", { timeout: 30000, minCheckboxes: 2 });
      const v2 = await verifyCamposApplied(page, "#ModulosArticulos", templateObj);
      console.log("🔍 VERIFY ARTICULOS:", JSON.stringify(v2));

      await sleep(250);
      await snapshot(page, outDir, "campos_aplicado_todos");

      if (AUTO_SAVE_CAMPOS) {
        // ✅ Guardar Socios
        await activateTabForContainer(page, "#ModulosSociosDeNegocios", { timeout: 30000, minCheckboxes: 2 });
        await clickButtonInContainerByAnyText(
          page,
          "#ModulosSociosDeNegocios",
          [
            "GUARDAR CAMPOS SOCIO DE NEGOCIO",
            "GUARDAR CAMPOS S. DE NEGOCIOS",
            "GUARDAR CAMPOS SOCIOS DE NEGOCIOS",
            "GUARDAR CAMPOS SOCIOS",
            "GUARDAR CAMPOS",
          ],
          { timeout: 15000 }
        );
        await sleep(Number(process.env.SAVE_WAIT_MS || 600));
        await snapshot(page, outDir, "guardar_campos_socios");

        // ✅ Guardar Artículos
        await activateTabForContainer(page, "#ModulosArticulos", { timeout: 30000, minCheckboxes: 2 });
        await clickButtonInContainerByAnyText(
          page,
          "#ModulosArticulos",
          ["GUARDAR DATOS DE ARTÍCULOS", "GUARDAR DATOS DE ARTICULOS", "GUARDAR ARTÍCULOS", "GUARDAR ARTICULOS"],
          { timeout: 15000 }
        );
        await sleep(Number(process.env.SAVE_WAIT_MS || 600));
        await snapshot(page, outDir, "guardar_datos_articulos");
      } else {
        console.log("ℹ️ AUTO_SAVE_CAMPOS=false -> NO se hace click en botones GUARDAR de Campos.");
      }
    }
  } catch (e) {
    console.log("⚠️ No se pudo procesar CAMPOS (Socios/Artículos):", e.message || e);
    try { await snapshot(page, outDir, "campos_ERROR"); } catch {}
  }

  // ----------------------
  // ✅ CREAR (según .env) + espera CREATE_WAIT_MS
  // ----------------------
  const r = await clickCrearUsuarioSiCorresponde(page);

  const waitMs = Number(process.env.CREATE_WAIT_MS || 800);
  if (r?.clicked) {
    console.log(`⏳ Esperando CREATE_WAIT_MS=${waitMs}ms...`);
    await sleep(waitMs);
  } else {
    await sleep(800);
  }

  await snapshot(page, outDir, "post_crear_si_corresponde");
}

/* -------------------------------------------------------------------------- */
/* MAIN                                                                       */
/* -------------------------------------------------------------------------- */

(async () => {
  await fs.ensureDir(RUN_LOG_DIR);
  important("🚀 Inicio RUN", { RUN_ID, RUN_LOG_DIR, LOG_FILE, JOB_BASE_DIR });

  const BASE_URL = process.env.SCRAPE_URL || "https://sap2.llamagas.nubeprivada.biz/";
  const USER = process.env.LOGIN_USER;
  const PASS = process.env.LOGIN_PASS;

  const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() === "true";
  const KEEP_OPEN = String(process.env.KEEP_OPEN || "false").toLowerCase() === "true";
  const AUTO_SAVE_CAMPOS = String(process.env.AUTO_SAVE_CAMPOS || "true").toLowerCase() === "true";

  const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1536", 10);
  const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "864", 10);
  const DEVICE_SCALE_FACTOR = parseFloat(process.env.DEVICE_SCALE_FACTOR || "1");

  // ✅ FIX DEFINITIVO: directorios con prioridad a /webapp si existe
  const PERMISOS_DIR = resolveDir("PERMISOS_DIR", [
    path.join(ROOT_CWD, "permisos_modulos"),
    path.join(ROOT_CWD, "webapp", "permisos_modulos"),
  ]);

  const CAMPOS_DIR = resolveDir("CAMPOS_DIR", [
    path.join(ROOT_CWD, "webapp", "permisos_campossap"),
    path.join(ROOT_CWD, "permisos_campossap"),
  ]);

  // ✅ FIX DEFINITIVO: archivos pueden ser nombre o ruta completa
  let permisosPath = resolveFilePath(process.env.PERMISOS_FILE, PERMISOS_DIR, "branch.json");
  let camposPath = resolveFilePath(process.env.CAMPOS_FILE, CAMPOS_DIR, "branch.json");

  // ✅ AUTO-PICK si el JSON existe con otro nombre
  permisosPath = pickJsonTemplate(permisosPath, path.dirname(permisosPath), []);
  const permisosBaseName = path.basename(permisosPath || "branch.json");
  camposPath = pickJsonTemplate(camposPath, path.dirname(camposPath), [permisosBaseName, "branch.json", "counter.json"]);

  if (!USER || !PASS) throw new Error("Faltan LOGIN_USER o LOGIN_PASS en tu .env");

  // ✅ CAMBIO PEDIDO: salida aislada por JOB_OUTPUT_DIR
  const IS_JOB_MODE = !!process.env.JOB_OUTPUT_DIR;
  const OUT_ROOT = path.join(JOB_BASE_DIR, HTML_DIR_NAME);
  const outDir = IS_JOB_MODE ? OUT_ROOT : path.join(OUT_ROOT, `run_${RUN_ID}`);

  await fs.ensureDir(OUT_ROOT);
  await fs.ensureDir(outDir);

  // ✅ IMPORTANTE: crea SOLO los directorios necesarios (en base al FILE real)
  await fs.ensureDir(path.dirname(permisosPath));
  await fs.ensureDir(path.dirname(camposPath));

  console.log("📁 Ruta módulos :", permisosPath);
  console.log("📁 Ruta campos  :", camposPath);

  if (!fs.existsSync(camposPath)) {
    console.warn("⚠️ OJO: NO existe la plantilla CAMPOS en esa ruta. Si existe en webapp/, revisa CAMPOS_DIR/CAMPOS_FILE.");
  }
  if (!fs.existsSync(permisosPath)) {
    console.warn("⚠️ OJO: NO existe la plantilla MÓDULOS en esa ruta. Si existe en webapp/, revisa PERMISOS_DIR/PERMISOS_FILE.");
  }

  important("📁 Output", { OUT_ROOT, outDir, IS_JOB_MODE, PERMISOS_DIR, CAMPOS_DIR });

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    ignoreHTTPSErrors: true,
    defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      "--start-maximized",
    ],
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(120000);
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning") console.log("BROWSER:", t, msg.text());
  });

  important("🌐 Abriendo URL", { BASE_URL });
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // Login
  await page.waitForSelector("#usuario", { timeout: 60000 });
  await typeSlow(page, "#usuario", USER, { delay: 20 });

  await page.waitForSelector('input[type="password"]', { timeout: 60000 });
  await typeSlow(page, 'input[type="password"]', PASS, { delay: 20 });

  await page.click('button[type="submit"]');
  await sleep(900);

  // Detectar 2FA
  let needs2FA = false;
  try {
    await page.waitForFunction(() => {
      const m = document.getElementById("TwoStepsModal-TwoSteps");
      return !!m && m.classList.contains("show");
    }, { timeout: 8000 });
    needs2FA = true;
  } catch {}

  if (needs2FA) {
    important("🔐 2FA detectado. Ingresa el código de 6 dígitos.");
    const code = (await ask("Código 2FA: ")).trim();

    const otpSel = '#TwoStepsModal-TwoSteps input[type="text"]';
    await page.waitForSelector(otpSel, { timeout: 30000 });
    await typeSlow(page, otpSel, code, { delay: 40 });
    await page.keyboard.press("Enter");
    await sleep(1100);
  }

  // Ir a Admin. de usuarios
  const adminCardSel = 'span[routerlink="/adminUsers"]';
  await page.waitForSelector(adminCardSel, { timeout: 60000 });
  await page.click(adminCardSel);

  await page.waitForFunction(
    () => window.location.pathname.includes("/adminUsers") || window.location.href.includes("/adminUsers"),
    { timeout: 60000 }
  );

  await sleep(900);
  await snapshot(page, outDir, "adminUsers");

  // ✅ MODO MASIVO (Excel)
  const EXCEL_MASIVO = String(process.env.EXCEL_MASIVO || "false").toLowerCase() === "true";
  const excelFile = process.env.EXCEL_FILE || "EXCEL/usuarios.xlsx";

  if (EXCEL_MASIVO) {
    const { users, excelFullPath, sheetName, totalRows } = readUsersFromExcel(excelFile);
    important("📄 Excel leído", { excelFullPath, sheetName, totalRows, usuarios_validos: users.length });

    if (!users.length) {
      throw new Error("Tu Excel no tiene filas válidas. Asegúrate de llenar todas las columnas requeridas.");
    }

    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < users.length; i++) {
      const u = users[i];

      process.env.NEW_USER_SUCURSAL = u.NEW_USER_SUCURSAL || "";
      process.env.NEW_USER_CODE = u.NEW_USER_CODE || "";
      process.env.NEW_USER_NAME = u.NEW_USER_NAME || "";
      process.env.NEW_USER_EMAIL = u.NEW_USER_EMAIL || "";
      process.env.NEW_USER_PASS = u.NEW_USER_PASS || "";
      process.env.NEW_USER_TIPO = u.NEW_USER_TIPO || "";
      process.env.NEW_USER_COUNTER_ROL = u.NEW_USER_COUNTER_ROL || "";

      const userTag = `${u.NEW_USER_CODE}`.replace(/[^\w.-]+/g, "_");
      const userDir = path.join(outDir, `user_${String(i + 1).padStart(3, "0")}_${userTag}`);
      await fs.ensureDir(userDir);

      important(`👤 (${i + 1}/${users.length}) PROCESANDO`, {
        excelRow: u.index,
        code: u.NEW_USER_CODE,
        tipo: u.NEW_USER_TIPO,
        sucursal: u.NEW_USER_SUCURSAL,
      });

      try {
        await processOneUserFlow(page, {
          outDir: userDir,
          permisosPath,
          camposPath,
          AUTO_SAVE_CAMPOS,
        });

        okCount++;
        important(`✅ OK usuario ${userTag}`, { excelRow: u.index });
      } catch (e) {
        failCount++;
        important(`❌ FAIL usuario ${userTag}`, { excelRow: u.index, error: e?.message || String(e) });
        try { await snapshot(page, userDir, "ERROR"); } catch {}
      }
    }

    important("📌 RESUMEN MASIVO", { ok: okCount, fail: failCount, total: users.length, outDir, log: LOG_FILE });

    if (KEEP_OPEN) {
      important("🟢 KEEP_OPEN=true -> navegador quedará abierto.");
      await ask("Presiona ENTER para cerrar el navegador...");
    }

    await browser.close();
    return;
  }

  // ✅ MODO NORMAL (1 usuario por .env)
  await processOneUserFlow(page, {
    outDir,
    permisosPath,
    camposPath,
    AUTO_SAVE_CAMPOS,
  });

  important("✅ Listo (modo normal).", { outDir, log: LOG_FILE });

  if (KEEP_OPEN) {
    important("🟢 KEEP_OPEN=true -> navegador quedará abierto.");
    await ask("Presiona ENTER para cerrar el navegador...");
  }

  await browser.close();
})().catch((err) => {
  important("💥 Error fatal", { error: err?.message || String(err) });
  process.exit(1);
});
