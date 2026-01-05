#!/usr/bin/env node
// scrape_html.js
// --------------------------------------------------------------------------------------------
// LINKS (Docs oficiales):
// - Puppeteer: https://pptr.dev/
// - dotenv: https://github.com/motdotla/dotenv
// - fs-extra: https://github.com/jprichardson/node-fs-extra
// - xlsx: https://github.com/SheetJS/sheetjs
//
// NOTA SERVIDOR (Linux):
// - Recomendado: usar Chromium del sistema y evitar download pesado de Puppeteer.
//   Exporta: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser  (o /usr/bin/chromium)
// - Dependencias típicas (Ubuntu/Debian) para Chromium headless:
//   sudo apt-get update && sudo apt-get install -y \
//     chromium-browser chromium-codecs-ffmpeg \
//     fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 \
//     libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 \
//     libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 \
//     libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
//     libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates lsb-release wget xdg-utils
//
// --------------------------------------------------------------------------------------------
// FIX REAL AUTOCOMPLETE (Sucursal):
// - NO usamos TAB para "confirmar" (en tu UI TAB no selecciona, solo cambia foco).
// - Estrategia nueva:
//   1) Escribir query -> detectar popup -> elegir mejor opción -> MARK (data-autofill="pick")
//      -> page.click('[data-autofill="pick"]') (click real del navegador) -> blur por JS -> validar
//   2) Fallback: teclado determinístico (ArrowDown hasta índice exacto) + Enter (SIN TAB)
//   3) Fallback: click por coordenadas (page.mouse) al centro del item
// - Validación: ng-invalid / aria-invalid / feedback "escoge ... sucursal"
//
// ✅ NUEVO (ARREGLADO): Counter rol (solo cuando el tipo = COUNTER o ADMINISTRADOR)
// - Lee NEW_USER_COUNTER_ROL (puede ser TEXTO visible p.ej. "CAJA" o VALUE interno p.ej. "cashRegister")
// - YA NO usa un ID fijo (porque te estaba agarrando el SELECT equivocado).
// - Detecta el SELECT correcto por el LABEL (contiene "rol"/"caja"/"counter") y EXCLUYE "Tipo de usuario".
// - Si el tipo es COUNTER/ADMIN y NO aparece el select => ERROR (para que no se “pase”)
// - Si el tipo NO es COUNTER/ADMIN y no aparece => lo ignora
//
// ✅ AGREGADO SIN TOCAR TU LÓGICA:
// - MODO MASIVO por Excel (EXCEL_MASIVO=true, EXCEL_FILE=EXCEL/usuarios.xlsx)
// - LOGS a archivo + consola filtrada (LOG_DIR, CONSOLE_LEVEL)
// - Uso de CREATE_WAIT_MS (espera configurable tras crear)
// --------------------------------------------------------------------------------------------

const fs = require("fs-extra");
const path = require("path");

// ✅ dotenv desde el mismo directorio del script (evita problemas con PM2/cron)
require("dotenv").config({ path: path.join(__dirname, ".env") });

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
/* ✅ ROOT estable (útil en servidor)                                          */
/* -------------------------------------------------------------------------- */

const ROOT = process.env.WORKDIR
  ? path.resolve(process.env.WORKDIR)
  : process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : process.cwd();

/* -------------------------------------------------------------------------- */
/* ✅ LOGGING (archivo + consola filtrada)                                     */
/* -------------------------------------------------------------------------- */

const RUN_ID = ts();
const LOG_DIR = path.join(ROOT, process.env.LOG_DIR || "LOGS");
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
  // Redacción simple: si por algún motivo se imprimen credenciales
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
  logToFile(line).catch(() => { });

  // A consola solo si corresponde
  if (shouldPrint(level)) {
    if (level === "warn") ORIG_CONSOLE.warn(line);
    else if (level === "error") ORIG_CONSOLE.error(line);
    else ORIG_CONSOLE.log(line);
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
  const full = path.isAbsolute(excelPath) ? excelPath : path.join(ROOT, excelPath);
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
  await fs.ensureDir(outDir); // ✅ aseguramos carpeta

  try {
    await page.evaluate(() => {
      document.documentElement.style.overflowX = "visible";
      document.body.style.overflowX = "visible";
    });
  } catch { }

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
  } catch { }

  const html = await page.content();
  const htmlPath = path.join(outDir, `${prefix}_${stamp}.html`);
  const pngPath = path.join(outDir, `${prefix}_${stamp}.png`);
  await fs.writeFile(htmlPath, html, "utf8");
  await page.screenshot({ path: pngPath, fullPage: true });

  // ✅ para que se vea en consola con CONSOLE_LEVEL=important
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

/**
 * Busca el SELECT de "Counter rol" por LABEL/estructura (NO por ID fijo).
 * Excluye el select de "Tipo de usuario".
 * Luego hace match por VALUE o por TEXTO (y con sinónimos CAJA<->cash/register).
 */
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

      const looksTipo = optsTextJoined.includes("branch") && optsTextJoined.includes("counter") && optsTextJoined.includes("admin");
      let score =
        (lab.includes("rol") ? 5 : 0) +
        (lab.includes("caja") ? 5 : 0) +
        (lab.includes("counter") ? 4 : 0) +
        ((id.includes("rol") || name.includes("rol")) ? 3 : 0) +
        ((id.includes("cash") || name.includes("cash") || id.includes("register") || name.includes("register")) ? 3 : 0) +
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
  } catch { }

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
    } catch { }
    try {
      document.body && document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.body && document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.body && document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } catch { }
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
/* FIX: CLICK GUARDAR MÁS RÁPIDO                                               */
/* -------------------------------------------------------------------------- */

async function clickButtonInContainerByText(page, containerSelector, textWanted, { timeout = 12000 } = {}) {
  const wanted = norm(textWanted);
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const res = await page.evaluate(({ containerSelector, wanted }) => {
      const container = document.querySelector(containerSelector);
      if (!container) return { ok: false, reason: "No existe container" };

      const norm2 = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const btn = Array.from(container.querySelectorAll("button")).find((b) => norm2(b.textContent).includes(wanted));
      if (!btn) return { ok: false, reason: "No existe botón aún" };

      btn.scrollIntoView({ block: "center", inline: "center" });
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      return { ok: true };
    }, { containerSelector, wanted });

    if (res.ok) return;
    await sleep(200);
  }

  throw new Error(`No se pudo click ${textWanted} dentro de ${containerSelector} (timeout corto).`);
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

function normalizeTemplateToObject(templateAny) {
  if (templateAny && typeof templateAny === "object" && !Array.isArray(templateAny)) {
    const out = {};
    for (const [k, v] of Object.entries(templateAny)) {
      if (v && typeof v === "object") {
        out[k] = {
          activo: typeof v.activo === "boolean" ? v.activo : undefined,
          escritura: typeof v.escritura === "boolean" ? v.escritura : undefined,
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
        activo: typeof item.activo === "boolean" ? item.activo : undefined,
        escritura: typeof item.escritura === "boolean" ? item.escritura : undefined,
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

    const setCheckbox = (cb, wanted) => {
      if (!cb || typeof wanted !== "boolean") return;
      const current = !!cb.checked;
      if (current === wanted) return;

      cb.scrollIntoView({ block: "center", inline: "center" });
      cb.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      cb.click();
      cb.dispatchEvent(new Event("change", { bubbles: true }));
      cb.dispatchEvent(new Event("input", { bubbles: true }));
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
/* TABS                                                                        */
/* -------------------------------------------------------------------------- */

async function activateTabByText(page, tabText, { timeout = 15000 } = {}) {
  const wanted = norm(tabText);

  await page.waitForFunction(
    (wanted) => {
      const norm2 = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const links = Array.from(document.querySelectorAll("a.nav-link, a[data-toggle='tab'], a[role='tab']"));
      return links.some((a) => norm2(a.innerText || a.textContent).includes(wanted));
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

    const links = Array.from(document.querySelectorAll("a.nav-link, a[data-toggle='tab'], a[role='tab']"));
    const a = links.find((x) => norm2(x.innerText || x.textContent).includes(wanted));
    if (!a) throw new Error("No se encontró tab: " + wanted);

    a.scrollIntoView({ block: "center", inline: "center" });
    a.click();
  }, wanted);

  await sleep(350);
}

/* -------------------------------------------------------------------------- */
/* CAMPOS SAP + ARTÍCULOS (GENÉRICO)                                           */
/* -------------------------------------------------------------------------- */

async function extractCamposSAPGeneric(page, containerSelector) {
  return await page.evaluate((containerSelector) => {
    const container = document.querySelector(containerSelector);
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

function normalizeCamposTemplateToObject(templateAny) {
  const pickBool = (v) => (typeof v === "boolean" ? v : undefined);

  if (templateAny && typeof templateAny === "object" && !Array.isArray(templateAny)) {
    const out = {};
    for (const [k, v] of Object.entries(templateAny)) {
      if (!v || typeof v !== "object") continue;
      out[k] = {
        mostrar: pickBool(v.mostrar ?? v.show ?? v.visible ?? v.ver),
        editar: pickBool(v.editar ?? v.edit ?? v.escritura),
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
        mostrar: pickBool(it.mostrar ?? it.show ?? it.visible ?? it.ver),
        editar: pickBool(it.editar ?? it.edit ?? it.escritura),
      };
    }
    return out;
  }

  return {};
}

async function applyCamposTemplateGeneric(page, containerSelector, templateObj) {
  return await page.evaluate((containerSelector, templateObj) => {
    const container = document.querySelector(containerSelector);
    if (!container) throw new Error(`No existe ${containerSelector}`);

    const setCheckbox = (cb, wanted) => {
      if (!cb || typeof wanted !== "boolean") return;
      const current = !!cb.checked;
      if (current === wanted) return;

      cb.scrollIntoView({ block: "center", inline: "center" });
      cb.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      cb.click();
      cb.dispatchEvent(new Event("change", { bubbles: true }));
      cb.dispatchEvent(new Event("input", { bubbles: true }));
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

    const logs = { touched: 0, notFound: [] };

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
  });

  console.log("✅ Click en 'Crear' realizado (AUTO_CREATE=true).");
  return { clicked: true };
}

/* -------------------------------------------------------------------------- */
/* ✅ NAVEGACIÓN A MÓDULO USUARIOS                                             */
/* -------------------------------------------------------------------------- */

async function waitForCreationResult(page) {
  important("⏳ Verificando resultado de creación...");

  // Usamos evaluate para chequear el DOM
  const result = await page.evaluate(async () => {
    const checkInterval = 500;
    const maxTime = 10000;
    let elapsed = 0;

    return new Promise(resolve => {
      const timer = setInterval(() => {
        elapsed += checkInterval;
        const modal = document.querySelector("#adminUsersModal");

        // 1. Success: Modal gone or hidden (means saved & closed)
        // Validamos que NO tenga la clase show y Display none
        if (!modal || !modal.classList.contains("show") || modal.style.display === "none") {
          clearInterval(timer);
          resolve({ ok: true, msg: "Modal cerrado correctamente." });
          return;
        }

        // 2. Failure: Look for typical error feedbacks (bootstrap/custom)
        // Adjust selectors if needed: .invalid-feedback, .alert, .toast-error
        const errors = Array.from(modal.querySelectorAll(".invalid-feedback, .alert-danger, .text-danger, .toast-error"));
        // Filtramos los que son visibles
        const visibleError = errors.find(e => e.offsetParent !== null && e.innerText.trim().length > 0);

        if (visibleError) {
          clearInterval(timer);
          resolve({ ok: false, msg: "Error detectado en modal: " + visibleError.innerText.trim() });
          return;
        }

        // Timeout
        if (elapsed >= maxTime) {
          clearInterval(timer);
          resolve({ ok: false, warning: "Tiempo de espera agotado, el modal sigue abierto." });
        }
      }, checkInterval);
    });
  });

  if (result.ok) {
    important(`✅ ÉXITO: Usuario creado. (${result.msg})`);
    // No lanzamos error, el flujo sigue y el main loop reportará "✅ Usuario OK" al server
  } else if (result.warning) {
    log("warn", `⚠️ ALERTA: ${result.warning}`);
    // Dependiendo de lo estricto, podríamos perdonarlo o fallar. 
    // Si el modal sigue abierto, probablemente NO se guardó. Lanzamos error.
    throw new Error(result.warning);
  } else {
    log("error", `❌ ERROR: No se pudo crear el usuario. ${result.msg}`);
    throw new Error(result.msg);
  }
}

/* -------------------------------------------------------------------------- */
/* ✅ CLOSE BLOCKING MODALS                                                   */
/* -------------------------------------------------------------------------- */

async function closeUnexpectedModals(page) {
  try {
    const modalSel = "#FileUploaderModal";
    const isVisible = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && (el.classList.contains("show") || el.style.display === "block");
    }, modalSel);

    if (isVisible) {
      console.log("⚠️ Detectado modal bloqueante (#FileUploaderModal). Cerrando...");

      // Intentar cerrar con botón "Cerrar" o "X"
      const closed = await page.evaluate((sel) => {
        const m = document.querySelector(sel);
        if (!m) return false;

        const closeBtns = Array.from(m.querySelectorAll(".botonCerrar, .close, button.close"));
        const btn = closeBtns.find(b => b.offsetParent !== null); // visible
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }, modalSel);

      if (closed) {
        await sleep(1000);
        console.log("✅ Modal cerrado.");
      } else {
        console.log("⚠️ No se pudo clickear botón de cerrar en el modal bloqueante.");
      }
    }
  } catch (e) {
    console.log("⚠️ Error intentando cerrar modales bloqueantes:", e.message);
  }
}

async function navigateToUsersModule(page) {
  console.log("🧭 Navegando al módulo de Usuarios (Selector RouterLink)...");

  // 0. Limpiar modales molestos antes de empezar
  await closeUnexpectedModals(page);

  const crearBtnSel = 'button.btn.btn-outline-secondary.btn-timbra-one.mr-sm-3';

  // 1. Chequear si YA estamos ahí
  try {
    const yaExiste = await page.$(crearBtnSel);
    if (yaExiste) {
      const visible = await page.evaluate(el => {
        const s = window.getComputedStyle(el);
        return s && s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
      }, yaExiste);

      if (visible) {
        console.log("✅ Ya estamos en el módulo (botón Crear detectado al inicio).");
        return;
      }
    }
  } catch { }

  // 2. Navegar (USANDO SELECTOR EXACTO DEL USUARIO)
  let navigated = false;
  try {
    console.log("👉 Intentando click en selector [routerlink='/adminUsers']...");
    await page.waitForSelector("span[routerlink='/adminUsers']", { timeout: 6000 });
    await page.click("span[routerlink='/adminUsers']");
    navigated = true;
  } catch (e) {
    console.log("⚠️ No se encontró selector routerlink. Probando texto exacto 'Admin. de usuarios'...");
    try {
      await clickByText(page, "Admin. de usuarios", { timeout: 6000 });
      navigated = true;
    } catch (e2) {
      console.log("⚠️ Fallaron los clicks de navegación (routerlink y texto).");
    }
  }

  // Esperar carga
  await sleep(2500);
  await closeUnexpectedModals(page);

  // 3. Validar si caímos en el módulo incorrecto (Documentos/Archivos) - Solo por si acaso
  const isWrongModule = await page.evaluate(() => {
    if (document.querySelector("#dataTableDocuments")) return true;
    const title = document.querySelector(".modal-title, h1, h2, h3, h4");
    if (title && (title.textContent || "").includes("archivos")) return true;
    return false;
  });

  if (isWrongModule) {
    console.log("⚠️ Detectado módulo INCORRECTO (Documentos).");
  }

  // Snapshot de debug
  const outDir = path.join(path.resolve(process.env.APP_ROOT || process.cwd(), "HTML"), `run_${RUN_ID}`);
  await snapshot(page, outDir, "debug_post_nav_users");

  // 4. Validar llegada final
  try {
    await page.waitForSelector(crearBtnSel, { timeout: 15000 });
    console.log("✅ Ya estamos en el módulo (botón Crear visible).");
  } catch {
    console.log("⚠️ No se detectó botón Crear. Dump de botones:");

    // Debug: Listar botones visibles
    const buttons = await page.evaluate(() => {
      const bs = Array.from(document.querySelectorAll("button, a.btn"));
      return bs.map(b => ({
        text: (b.innerText || "").trim(),
        visible: (b.offsetParent !== null)
      })).filter(x => x.visible);
    });
    console.log("Validation: Botones visibles:", JSON.stringify(buttons, null, 2));
  }
}

/* -------------------------------------------------------------------------- */
/* ✅ UTIL: Abrir modal "Crear usuario" (para masivo)                           */
/* -------------------------------------------------------------------------- */

async function openCrearUsuarioModal(page) {
  const crearBtnSel = 'button.btn.btn-outline-secondary.btn-timbra-one.mr-sm-3';
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
/* ✅ BLOQUE COMPLETO (TU LÓGICA) para procesar 1 usuario                       */
/*    (Se usa igual en modo normal y modo Excel, SIN borrar pasos)             */
/* -------------------------------------------------------------------------- */

async function processOneUserFlow(page, {
  outDir,
  permisosPath,
  camposPath,
  AUTO_SAVE_CAMPOS,
  rowIndex,
} = {}) {
  const logProgress = (msg) => {
    if (rowIndex) important(`ℹ️ [ROW ${rowIndex}] MSG:${msg}`);
    else console.log(`ℹ️ MSG:${msg}`);
  };

  logProgress("Navegando al módulo Usuarios...");
  // 0) Navegar a Módulo Usuarios (Fix)
  await navigateToUsersModule(page);

  logProgress("Abriendo modal 'Crear usuario'...");
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
  // ✅ CAMPOS SAP + DATOS ARTÍCULOS + GUARDAR (MÁS RÁPIDO)
  // ----------------------
  try {
    const bpCatalog = await extractCamposSAPGeneric(page, "#ModulosSociosDeNegocios");

    try {
      await activateTabByText(page, "Datos de artículos");
    } catch { }
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

      const logsBP = await applyCamposTemplateGeneric(page, "#ModulosSociosDeNegocios", templateObj);
      console.log(`🧩 CAMPOS SOCIOS aplicados. Filas tocadas: ${logsBP.touched}`);

      try {
        await activateTabByText(page, "Datos de artículos");
      } catch { }
      const logsART = await applyCamposTemplateGeneric(page, "#ModulosArticulos", templateObj);
      console.log(`🧩 DATOS ARTÍCULOS aplicados. Filas tocadas: ${logsART.touched}`);

      await sleep(250);
      await snapshot(page, outDir, "campos_aplicado_todos");

      if (AUTO_SAVE_CAMPOS) {
        try {
          await activateTabByText(page, "Campos SAP");
        } catch { }
        await clickButtonInContainerByText(page, "#ModulosSociosDeNegocios", "GUARDAR CAMPOS S. DE NEGOCIOS", {
          timeout: 12000,
        });
        await sleep(Number(process.env.SAVE_WAIT_MS || 600));
        await snapshot(page, outDir, "guardar_campos_socios");

        try {
          await activateTabByText(page, "Datos de artículos");
        } catch { }
        await clickButtonInContainerByText(page, "#ModulosArticulos", "GUARDAR DATOS DE ARTÍCULOS", {
          timeout: 12000,
        });
        await sleep(Number(process.env.SAVE_WAIT_MS || 600));
        await snapshot(page, outDir, "guardar_datos_articulos");
      } else {
        console.log("ℹ️ AUTO_SAVE_CAMPOS=false -> NO se hace click en botones GUARDAR de Campos.");
      }
    }
  } catch (e) {
    console.log("⚠️ No se pudo procesar CAMPOS (Socios/Artículos):", e.message || e);
  }

  // ----------------------
  // ✅ CREAR (según .env) + espera CREATE_WAIT_MS
  // ----------------------
  const r = await clickCrearUsuarioSiCorresponde(page);

  const waitMs = Number(process.env.CREATE_WAIT_MS || 800);
  if (r?.clicked) {
    console.log(`⏳ Esperando CREATE_WAIT_MS=${waitMs}ms...`);
    await sleep(waitMs);
    // Verificar si funcionó
    await waitForCreationResult(page);
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
  important("🚀 Inicio RUN", { RUN_ID, RUN_LOG_DIR, LOG_FILE });

  const BASE_URL = process.env.SCRAPE_URL || "https://sap2.llamagas.nubeprivada.biz/";
  const USER = process.env.LOGIN_USER;
  const PASS = process.env.LOGIN_PASS;

  const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() === "true";
  const KEEP_OPEN = String(process.env.KEEP_OPEN || "false").toLowerCase() === "true";
  const AUTO_SAVE_CAMPOS = String(process.env.AUTO_SAVE_CAMPOS || "true").toLowerCase() === "true";

  const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1536", 10);
  const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "864", 10);
  const DEVICE_SCALE_FACTOR = parseFloat(process.env.DEVICE_SCALE_FACTOR || "1");

  const PERMISOS_DIR = path.join(ROOT, "permisos_modulos");
  const envFile = (process.env.PERMISOS_FILE || "").trim();
  const permisosFileName = envFile || "branch.json";
  const permisosPath = path.join(PERMISOS_DIR, path.basename(permisosFileName));

  const CAMPOS_DIR = path.join(ROOT, "permisos_campossap");
  const camposEnvFile = (process.env.CAMPOS_FILE || "").trim();
  const camposFileName = camposEnvFile || "branch.json";
  const camposPath = path.join(CAMPOS_DIR, path.basename(camposFileName));

  if (!USER || !PASS) throw new Error("Faltan LOGIN_USER o LOGIN_PASS en tu .env");

  // ✅ salida por run
  const OUT_ROOT = path.join(ROOT, "HTML");
  const outDir = path.join(OUT_ROOT, `run_${RUN_ID}`);
  await fs.ensureDir(OUT_ROOT);
  await fs.ensureDir(outDir);
  await fs.ensureDir(PERMISOS_DIR);
  await fs.ensureDir(CAMPOS_DIR);

  console.log("📁 Ruta módulos :", permisosPath);
  console.log("📁 Ruta campos  :", camposPath);
  important("📁 Output", { outDir });

  // ✅ En servidor, usa Chromium del sistema si se define
  const PUPPETEER_EXECUTABLE_PATH = String(process.env.PUPPETEER_EXECUTABLE_PATH || "").trim() || null;

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    ignoreHTTPSErrors: true,
    executablePath: PUPPETEER_EXECUTABLE_PATH || undefined,
    defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      "--start-maximized",
    ],
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(120000);
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  /* -------------------------------------------------------------------------- */
  /* ✅ EXTRA SERVER FIXES: Chromium path + request rewrite (como Playwright)    */
  /* -------------------------------------------------------------------------- */

  async function resolveExecutablePathMaybe() {
    // 1) Si lo pasas por env
    const envPath =
      process.env.CHROME_PATH ||
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      process.env.CHROMIUM_PATH;
    if (envPath && fs.existsSync(envPath)) {
      important("✅ Usando CHROME_PATH desde env", { envPath });
      return envPath;
    }

    // 2) Si Playwright está instalado (tu branchservice ya lo usa)
    try {
      const { chromium } = require("playwright");
      const p = chromium.executablePath();
      if (p && fs.existsSync(p)) {
        important("✅ Usando Chromium de Playwright", { executablePath: p });
        return p;
      }
    } catch { }

    // 3) Dejar que Puppeteer decida (solo funciona si descargó Chromium)
    important("ℹ️ Usando Chromium default de Puppeteer (si existe).");
    return undefined;
  }

  async function installRequestRewrite(page) {
    const enabled = String(process.env.ROUTE_ENABLED || "false").toLowerCase() === "true";
    if (!enabled) {
      important("ℹ️ ROUTE_ENABLED=false -> no se reescriben requests.");
      return;
    }

    const fromBase = (process.env.ROUTE_FROM_BASE || "").trim().replace(/\/+$/, "");
    const toBase = (process.env.ROUTE_TO_BASE || "").trim().replace(/\/+$/, "");

    if (!fromBase || !toBase) {
      important("⚠️ ROUTE_ENABLED=true pero falta ROUTE_FROM_BASE o ROUTE_TO_BASE.");
      return;
    }

    important("🔀 Request rewrite ON", { fromBase, toBase });

    await page.setRequestInterception(true);

    page.on("request", (req) => {
      try {
        const url = req.url();
        if (url.startsWith(fromBase)) {
          const u = new URL(url);
          const newUrl = toBase + u.pathname + u.search;
          return req.continue({ url: newUrl });
        }
        return req.continue();
      } catch {
        try { req.continue(); } catch { }
      }
    });

    page.on("requestfailed", (r) => {
      const f = r.failure();
      if (f) log("warn", `requestfailed: ${r.url()} => ${f.errorText}`);
    });
  }

  async function gotoWithFallback(page, url, fallbackUrl) {
    try {
      important("🌐 goto", { url });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      return url;
    } catch (e) {
      log("warn", "⚠️ goto falló (primario)", { url, err: String(e?.message || e) });
      if (!fallbackUrl) throw e;

      important("🌐 goto (fallback)", { fallbackUrl });
      await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      return fallbackUrl;
    }
  }

  async function autoLoginPuppeteer(page, email, pass) {
    const emailSelectors = [
      'input[type="email"]',
      'input[name*="mail" i]',
      'input[id*="mail" i]',
      'input[placeholder*="mail" i]',
      'input[placeholder*="correo" i]',
      'input[placeholder*="email" i]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[placeholder*="usuario" i]',
    ];

    const passSelectors = [
      'input[type="password"]',
      'input[name*="pass" i]',
      'input[id*="pass" i]',
      'input[placeholder*="pass" i]',
      'input[placeholder*="contrase" i]',
    ];

    const buttonSelectors = [
      'button[type="submit"]',
      'button:contains("Iniciar")',
      'button:contains("Ingresar")',
      'button:contains("Login")',
      'button:contains("Sign")',
      'input[type="submit"]',
    ];

    const findFirst = async (selectors) => {
      for (const s of selectors) {
        const el = await page.$(s);
        if (el) return { sel: s, el };
      }
      return null;
    };

    await sleep(800);

    const emailEl = await findFirst(emailSelectors);
    const passEl = await findFirst(passSelectors);

    if (!emailEl || !passEl) {
      throw new Error(
        `No encontré inputs login. email=${!!emailEl} pass=${!!passEl}. Ajusta selectores o revisa HTML del login.`
      );
    }

    important("🔐 Login inputs", { emailSel: emailEl.sel, passSel: passEl.sel });

    await page.click(emailEl.sel, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(emailEl.sel, email, { delay: 10 });

    await page.click(passEl.sel, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(passEl.sel, pass, { delay: 10 });

    // Click submit si hay botón; si no, Enter
    let clicked = false;

    // puppeteer no soporta :has-text, entonces buscamos por texto con evaluate
    try {
      const didClick = await page.evaluate(() => {
        const norm2 = (s) =>
          String(s || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const btns = Array.from(document.querySelectorAll("button,input[type=submit]"));
        const target = btns.find((b) => {
          const t = norm2(b.innerText || b.value || b.textContent);
          return t.includes("iniciar") || t.includes("ingresar") || t.includes("login") || t.includes("entrar");
        });

        if (!target) return false;
        target.click();
        return true;
      });

      if (didClick) clicked = true;
    } catch { }

    if (!clicked) {
      // fallback: intenta selector submit
      for (const s of buttonSelectors) {
        try {
          const el = await page.$(s);
          if (el) {
            await el.click();
            clicked = true;
            break;
          }
        } catch { }
      }
    }

    if (!clicked) {
      await page.keyboard.press("Enter");
    }

    important("✅ Submit login disparado", { clicked });
  }

  async function waitLoginSuccess(page) {
    // Configurable: si sabes un selector del dashboard, ponlo en env LOGIN_SUCCESS_SELECTOR
    const successSel = (process.env.LOGIN_SUCCESS_SELECTOR || "").trim();
    const successUrlInc = (process.env.LOGIN_SUCCESS_URL_INCLUDES || "").trim();

    // Si no configuras nada, intentamos heurística: desaparece form login o aparece navbar / logout
    const timeout = 120000;

    if (successSel) {
      await page.waitForSelector(successSel, { timeout });
      return;
    }

    await page.waitForFunction(
      (successUrlInc) => {
        const u = location.href;
        if (successUrlInc && u.includes(successUrlInc)) return true;

        const norm2 = (s) =>
          String(s || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        // señales típicas de sesión iniciada
        const anyLogout =
          Array.from(document.querySelectorAll("a,button")).some((x) => {
            const t = norm2(x.innerText || x.textContent);
            return t.includes("cerrar sesion") || t.includes("logout") || t.includes("salir");
          });

        const hasNav =
          document.querySelector(".navbar, nav, app-navbar, header") != null;

        // señales de login aún presente
        const stillHasPass = document.querySelector('input[type="password"]') != null;

        return (anyLogout || hasNav) && !stillHasPass;
      },
      { timeout },
      successUrlInc
    );
  }

  /* -------------------------------------------------------------------------- */
  /* ✅ RE-LAUNCH browser con executablePath si hace falta (server)              */
  /* -------------------------------------------------------------------------- */

  // Cerramos el browser actual (porque lo lanzaste arriba sin executablePath)
  // y relanzamos con path estable si aplica.
  const execPath = await resolveExecutablePathMaybe();

  await browser.close().catch(() => { });

  const browser2 = await puppeteer.launch({
    headless: HEADLESS,
    ignoreHTTPSErrors: true,
    executablePath: execPath, // ✅ clave para servidor
    defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--ignore-certificate-errors",
      "--ignore-certificate-errors-spki-list",
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      "--start-maximized",
    ],
  });

  const page2 = await browser2.newPage();
  page2.setDefaultNavigationTimeout(120000);
  await page2.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR });

  // logs de consola del navegador (útil para ver errores de CORS, 401, etc.)
  page2.on("console", async (msg) => {
    try {
      const txt = msg.text();
      // todo a archivo, filtrado a consola por tu logger
      log("debug", `[BROWSER:${msg.type()}] ${txt}`);
    } catch { }
  });
  page2.on("pageerror", (err) => log("warn", "pageerror", { err: String(err?.message || err) }));

  // ✅ instalar rewrite antes de navegar
  await installRequestRewrite(page2);

  const FALLBACK_URL = (process.env.SCRAPE_FALLBACK_URL || process.env.FRONT_URL || "").trim() || null;

  // 1) Ir al login
  const openedUrl = await gotoWithFallback(page2, BASE_URL, FALLBACK_URL);
  await snapshot(page2, outDir, "00_open_login");

  // 2) Login
  important("🔐 Iniciando login...", { openedUrl });
  await autoLoginPuppeteer(page2, USER, PASS);

  try {
    await waitLoginSuccess(page2);
    important("✅ Login OK", { url: await page2.url() });
  } catch (e) {
    await snapshot(page2, outDir, "00_login_failed");
    throw new Error("❌ Login no confirmó éxito. Revisa snapshot 00_login_failed: " + (e?.message || e));
  }

  await snapshot(page2, outDir, "01_after_login");

  /* -------------------------------------------------------------------------- */
  /* ✅ EJECUCIÓN FLUJO: 1 usuario (env) o masivo (Excel)                        */
  /* -------------------------------------------------------------------------- */

  const EXCEL_MASIVO = String(process.env.EXCEL_MASIVO || "false").toLowerCase() === "true";
  const EXCEL_FILE = (process.env.EXCEL_FILE || "").trim();

  // helper: setear env por usuario para reutilizar tus funciones sin reescribirlas
  async function withUserEnv(userObj, fn) {
    const keys = [
      "NEW_USER_SUCURSAL",
      "NEW_USER_CODE",
      "NEW_USER_NAME",
      "NEW_USER_EMAIL",
      "NEW_USER_PASS",
      "NEW_USER_TIPO",
      "NEW_USER_COUNTER_ROL",
    ];

    const backup = {};
    for (const k of keys) backup[k] = process.env[k];

    try {
      for (const k of keys) {
        if (userObj && userObj[k] !== undefined) process.env[k] = String(userObj[k] ?? "").trim();
      }
      return await fn();
    } finally {
      for (const k of keys) {
        if (backup[k] === undefined) delete process.env[k];
        else process.env[k] = backup[k];
      }
    }
  }

  if (EXCEL_MASIVO) {
    if (!EXCEL_FILE) throw new Error("EXCEL_MASIVO=true pero falta EXCEL_FILE en .env");

    const { users, excelFullPath, sheetName, totalRows } = readUsersFromExcel(EXCEL_FILE);
    important("📘 Excel masivo leído", { excelFullPath, sheetName, totalRows, users: users.length });

    if (!users.length) throw new Error("No hay filas válidas en el Excel (revisa headers y campos obligatorios).");

    for (const u of users) {
      important("👤 Procesando usuario Excel", { row: u.index, code: u.NEW_USER_CODE, email: u.NEW_USER_EMAIL });

      await withUserEnv(u, async () => {
        try {
          // AQUI usamos el rowIndex
          await processOneUserFlow(page2, { outDir, permisosPath, camposPath, AUTO_SAVE_CAMPOS, rowIndex: u.index });
          important("✅ OK usuario", { row: u.index, code: u.NEW_USER_CODE });
        } catch (e) {
          log("error", "❌ FAIL usuario", { row: u.index, err: String(e?.message || e) });
          await snapshot(page2, outDir, `ERR_user_row_${u.index}`);
          // sigue con el siguiente (no aborta todo)
        }
      });
    }
  } else {
    // Modo normal (solo env)
    await processOneUserFlow(page2, { outDir, permisosPath, camposPath, AUTO_SAVE_CAMPOS });
  }

  /* -------------------------------------------------------------------------- */
  /* ✅ Final                                                                    */
  /* -------------------------------------------------------------------------- */

  if (KEEP_OPEN) {
    important("🟡 KEEP_OPEN=true -> dejando browser abierto. CTRL+C para salir.");
    // mantener vivo
    // eslint-disable-next-line no-constant-condition
    while (true) await sleep(1000);
  } else {
    await browser2.close().catch(() => { });
    important("✅ FIN OK (browser cerrado)");
  }
})().catch(async (e) => {
  try {
    log("error", "💥 ERROR FATAL", { err: String(e?.message || e) });
  } catch { }
  process.exitCode = 1;
});
