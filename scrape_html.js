// scrape_html.js
require("dotenv").config();
const fs = require("fs-extra");
const path = require("path");
const puppeteer = require("puppeteer");
const readline = require("readline");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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

// Click por texto (robusto para SPA / botones sin id)
async function clickByText(page, text, { timeout = 60000 } = {}) {
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
 * ✅ Snapshot mejorado:
 * - Fuerza overflow-x visible
 * - Ajusta viewport al ancho real del documento (hasta maxWidth)
 */
async function snapshot(page, outDir, prefix, { maxWidth = 2400 } = {}) {
  const stamp = ts();

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
      await sleep(200);
    }
  } catch {}

  const html = await page.content();
  const htmlPath = path.join(outDir, `${prefix}_${stamp}.html`);
  const pngPath = path.join(outDir, `${prefix}_${stamp}.png`);
  await fs.writeFile(htmlPath, html, "utf8");
  await page.screenshot({ path: pngPath, fullPage: true });

  console.log(`📌 Snapshot: ${prefix}`);
  console.log("   HTML:", htmlPath);
  console.log("   PNG :", pngPath);
}

// ✅ Click específico del botón (icono fa-list) del bloque cuyo label sea “Módulos”
async function clickModulosButton(page, { timeout = 60000 } = {}) {
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
        const groups = Array.from(root.querySelectorAll(".input-group.mb-3"));
        for (const g of groups) {
          const label = g.querySelector(".input-group-prepend .input-group-text");
          const btn = g.querySelector('button[type="button"].input-group-text');
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
      const groups = Array.from(root.querySelectorAll(".input-group.mb-3"));
      for (const g of groups) {
        const label = g.querySelector(".input-group-prepend .input-group-text");
        const btn = g.querySelector('button[type="button"].input-group-text');
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
    const isDisplayed = (m.getAttribute("style") || "").includes("display: block");
    return isShown || isDisplayed;
  }, { timeout });

  await page.waitForFunction(() => {
    const modal = document.querySelector("#modulesModal");
    if (!modal) return false;
    const rows = modal.querySelectorAll("tbody tr");
    return rows && rows.length > 0;
  }, { timeout: 30000 });
}

// Scroll dentro del contenedor de la tabla (por si hay overflow)
async function scrollModulesTableToBottom(page, { maxLoops = 40 } = {}) {
  for (let i = 0; i < maxLoops; i++) {
    const didMove = await page.evaluate(() => {
      const modal = document.querySelector("#modulesModal");
      if (!modal) return false;

      const scroller =
        modal.querySelector(".table-scroll") ||
        modal.querySelector(".modal-body") ||
        modal;

      const prev = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      return scroller.scrollTop !== prev;
    });

    await sleep(200);
    if (!didMove) break;
  }
}

// Lee módulos: título + checked de Activo/Escritura
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

// ✅ Convierte a formato “objeto por título”
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

// Aplica plantilla (marcar/desmarcar) por título
async function applyModulesTemplate(page, templateObj) {
  const result = await page.evaluate((templateObj) => {
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
      const activoWanted = conf ? conf.activo : undefined;
      const escrituraWanted = conf ? conf.escritura : undefined;

      setCheckbox(cbs[0], activoWanted);
      setCheckbox(cbs[1], escrituraWanted);
      logs.touched++;
    }

    return logs;
  }, templateObj);

  return result;
}

async function clickGuardarModulesModal(page, { timeout = 30000 } = {}) {
  await page.waitForFunction(() => {
    const modal = document.querySelector("#modulesModal");
    if (!modal) return false;
    const btns = Array.from(modal.querySelectorAll("button"));
    return btns.some((b) => (b.textContent || "").trim().toLowerCase() === "guardar");
  }, { timeout });

  await page.evaluate(() => {
    const modal = document.querySelector("#modulesModal");
    const btn = Array.from(modal.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim().toLowerCase() === "guardar"
    );
    if (!btn) throw new Error("No se encontró el botón Guardar en módulos");
    btn.scrollIntoView({ block: "center", inline: "center" });
    btn.click();
  });

  try {
    await page.waitForFunction(() => {
      const m = document.querySelector("#modulesModal");
      if (!m) return true;
      const isShown = m.classList.contains("show");
      const isDisplayed = (m.getAttribute("style") || "").includes("display: block");
      return !(isShown || isDisplayed);
    }, { timeout: 15000 });
  } catch {}
}

/**
 * ✅ Llenar inputs del modal "Crear usuario" desde .env:
 *  - Código, Nombre, Correo
 *  - Contraseña y Confirmación (todos los password dentro del modal)
 */
async function fillCreateUserFromEnv(page) {
  const CODE = (process.env.NEW_USER_CODE || "").trim();
  const NAME = (process.env.NEW_USER_NAME || "").trim();
  const EMAIL = (process.env.NEW_USER_EMAIL || "").trim();
  const PASS = (process.env.NEW_USER_PASS || "").trim();

  if (!CODE && !NAME && !EMAIL && !PASS) {
    console.log("ℹ️ No hay NEW_USER_* en .env, no se llenan inputs.");
    return;
  }

  // Asegurar que el modal esté presente
  await page.waitForFunction(() => {
    const m = document.querySelector(".modal.show");
    return !!m;
  }, { timeout: 30000 });

  // Código / Nombre / Correo (IDs encontrados en tu HTML)
  const safeType = async (sel, value) => {
    if (!value) return;
    try {
      await page.waitForSelector(sel, { timeout: 15000 });
      await page.click(sel, { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type(sel, value, { delay: 10 });
    } catch (e) {
      console.log(`⚠️ No se pudo llenar ${sel}:`, e.message || e);
    }
  };

  await safeType("#User_USER_CODE", CODE);
  await safeType("#User_U_NAME", NAME);
  await safeType("#User_E_Mail", EMAIL);

  // Passwords (pueden ser 1 o 2: Nueva/Confirmar)
  if (PASS) {
    try {
      await page.evaluate((PASS) => {
        const modal = document.querySelector(".modal.show") || document;
        const passInputs = Array.from(modal.querySelectorAll('input[type="password"]'));

        const setVal = (el, val) => {
          if (!el) return;
          el.focus();
          el.value = "";
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };

        passInputs.forEach((inp) => setVal(inp, PASS));
      }, PASS);
    } catch (e) {
      console.log("⚠️ No se pudo llenar contraseña:", e.message || e);
    }
  }

  console.log("✅ Inputs de Crear usuario llenados desde .env");
}

/* -------------------------------------------------------------------------- */
/* ✅ TABS (para asegurar que “Datos de artículos” esté cargado/visible)       */
/* -------------------------------------------------------------------------- */

async function activateTabByText(page, tabText, { timeout = 30000 } = {}) {
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

  await sleep(600);
}

/* -------------------------------------------------------------------------- */
/* ✅ CAMPOS SAP / DATOS ARTÍCULOS (Mostrar/Editar)                             */
/*    FIX: ahora detecta TODAS las tablas dentro del container                 */
/*    (las 2 columnas: BPDA/BPCP/BPF y también la parte de artículos)          */
/* -------------------------------------------------------------------------- */

// Extraer catálogo (GENÉRICO) por container selector
async function extractCamposSAPGeneric(page, containerSelector) {
  return await page.evaluate((containerSelector) => {
    const container = document.querySelector(containerSelector);
    if (!container) throw new Error(`No existe ${containerSelector}`);

    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const out = [];

    // 👇 IMPORTANTE: hay 2 tablas (2 columnas). Tomamos TODAS.
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

        // Header de sección (colspan=3)
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

// Normaliza template Campos SAP => objeto por CODE
function normalizeCamposTemplateToObject(templateAny) {
  const pickBool = (v) => (typeof v === "boolean" ? v : undefined);

  // Caso A: objeto { "BPG0": {mostrar:true, editar:false}, ... }
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

  // Caso B: array [{code:"BPG0", mostrar:true, editar:false}, ...]
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

// Aplica template (GENÉRICO) por container selector
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

    // 👇 TOMAMOS TODOS los checkboxes del container (2 tablas/2 columnas)
    const inputs = Array.from(
      container.querySelectorAll('input[type="checkbox"][name^="show_"], input[type="checkbox"][name^="edit_"]')
    );

    // Map CODE => {showCb, editCb}
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
        // ojo: este log es por container (si el code es de otro tab, aquí no existe)
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

(async () => {
  const BASE_URL = process.env.SCRAPE_URL || "https://sap2.llamagas.nubeprivada.biz/";
  const USER = process.env.LOGIN_USER;
  const PASS = process.env.LOGIN_PASS;
  const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() === "true";

  const KEEP_OPEN = String(process.env.KEEP_OPEN || "false").toLowerCase() === "true";

  const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1920", 10);
  const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "1080", 10);
  const DEVICE_SCALE_FACTOR = parseFloat(process.env.DEVICE_SCALE_FACTOR || "1");

  // ✅ Permisos MÓDULOS
  const PERMISOS_DIR = path.join(process.cwd(), "permisos_modulos");
  const profile = (process.env.PERMISOS_PROFILE || "").trim();
  const envFile = (process.env.PERMISOS_FILE || "").trim();
  const permisosFileName = envFile || (profile ? `${profile}.json` : "branch.json");
  const safeFileName = path.basename(permisosFileName);
  const permisosPath = path.join(PERMISOS_DIR, safeFileName);

  // ✅ Permisos CAMPOS SAP + ARTÍCULOS
  const CAMPOS_DIR = path.join(process.cwd(), "permisos_campossap");
  const camposProfile = (process.env.CAMPOS_PROFILE || "").trim();
  const camposEnvFile = (process.env.CAMPOS_FILE || "").trim();
  const camposFileName = camposEnvFile || (camposProfile ? `${camposProfile}.json` : "branch.json");
  const safeCamposFileName = path.basename(camposFileName);
  const camposPath = path.join(CAMPOS_DIR, safeCamposFileName);

  if (!USER || !PASS) throw new Error("Faltan LOGIN_USER o LOGIN_PASS en tu .env");

  const outDir = path.join(process.cwd(), "HTML");
  await fs.ensureDir(outDir);
  await fs.ensureDir(PERMISOS_DIR);
  await fs.ensureDir(CAMPOS_DIR);

  console.log("📄 Perfil módulos:", safeFileName);
  console.log("📁 Ruta módulos :", permisosPath);
  console.log("📄 Perfil campos :", safeCamposFileName);
  console.log("📁 Ruta campos  :", camposPath);

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

  console.log("Abriendo:", BASE_URL);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // Login
  await page.waitForSelector("#usuario", { timeout: 60000 });
  await page.click("#usuario", { clickCount: 3 });
  await page.type("#usuario", USER, { delay: 20 });

  await page.waitForSelector('input[type="password"]', { timeout: 60000 });
  await page.click('input[type="password"]', { clickCount: 3 });
  await page.type('input[type="password"]', PASS, { delay: 20 });

  await page.click('button[type="submit"]');
  await sleep(1200);

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
    console.log("2FA detectado. Ingresa el código de 6 dígitos del correo.");
    const code = (await ask("Código 2FA: ")).trim();

    const otpSel = '#TwoStepsModal-TwoSteps input[type="text"]';
    await page.waitForSelector(otpSel, { timeout: 30000 });
    await page.click(otpSel, { clickCount: 3 });
    await page.type(otpSel, code, { delay: 40 });
    await page.keyboard.press("Enter");
    await sleep(1500);
  }

  // Ir a Admin. de usuarios
  const adminCardSel = 'span[routerlink="/adminUsers"]';
  await page.waitForSelector(adminCardSel, { timeout: 60000 });
  await page.click(adminCardSel);

  await page.waitForFunction(
    () => window.location.pathname.includes("/adminUsers") || window.location.href.includes("/adminUsers"),
    { timeout: 60000 }
  );

  await sleep(1200);
  await snapshot(page, outDir, "adminUsers");

  // Crear usuario
  const crearBtnSel = 'button.btn.btn-outline-secondary.btn-timbra-one.mr-sm-3';
  try {
    await page.waitForSelector(crearBtnSel, { timeout: 20000 });
    await page.click(crearBtnSel);
  } catch {
    await clickByText(page, "Crear usuario", { timeout: 60000 });
  }

  await sleep(1200);
  await snapshot(page, outDir, "crearUsuario");

  // ✅ Llenar inputs Código/Nombre/Correo/Contraseña desde .env
  await fillCreateUserFromEnv(page);
  await sleep(300);
  await snapshot(page, outDir, "crearUsuario_lleno");

  // ----------------------
  // ✅ MÓDULOS
  // ----------------------
  await clickModulosButton(page, { timeout: 60000 });
  await sleep(800);

  await scrollModulesTableToBottom(page);
  await sleep(300);

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
    console.log("✅ Se creó plantilla de MÓDULOS:");
    console.log("   ", permisosPath);
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

    await sleep(500);
    await snapshot(page, outDir, "modulos_aplicado");

    await clickGuardarModulesModal(page);
    await sleep(1200);
    await snapshot(page, outDir, "modulos_guardado");
  }

  // ----------------------
  // ✅ CAMPOS SAP + DATOS ARTÍCULOS (FIX: 2 columnas + tab Artículos)
  // ----------------------
  try {
    // (A) SOCIOS DE NEGOCIOS: #ModulosSociosDeNegocios (incluye BPDA/BPCP/BPF)
    const bpCatalog = await extractCamposSAPGeneric(page, "#ModulosSociosDeNegocios");

    // (B) ARTÍCULOS: activar tab y leer #ModulosArticulos (incluye IDIA/IDDA)
    // Si tu UI carga lazy, esto asegura que exista DOM.
    try {
      await activateTabByText(page, "Datos de artículos");
    } catch (e) {
      console.log("ℹ️ No se pudo activar tab 'Datos de artículos' (puede ya estar visible):", e.message || e);
    }
    const artCatalog = await extractCamposSAPGeneric(page, "#ModulosArticulos");

    const camposCatalog = [...bpCatalog, ...artCatalog];

    await fs.writeJson(path.join(outDir, `campos_sap_catalog_${ts()}.json`), camposCatalog, { spaces: 2 });
    await fs.writeJson(path.join(outDir, `campos_sap_catalog_latest.json`), camposCatalog, { spaces: 2 });

    console.log(`🧾 Campos SAP + Artículos detectados: ${camposCatalog.length}`);

    // Si no existe template, lo creamos (por CODE) con TODO
    if (!(await fs.pathExists(camposPath))) {
      const templateObj = {};
      for (const c of camposCatalog) {
        if (!c.code) continue;
        templateObj[c.code] = { mostrar: c.mostrar === true, editar: c.editar === true };
      }
      await fs.writeJson(camposPath, templateObj, { spaces: 2 });
      console.log("✅ Se creó plantilla de CAMPOS (Socios + Artículos):");
      console.log("   ", camposPath);
      await snapshot(page, outDir, "campos_template_creado");
    } else {
      const rawCampos = await fs.readJson(camposPath);
      const templateObj = normalizeCamposTemplateToObject(rawCampos);

      // APLICAR en SOCIOS (pinta ambas columnas)
      const logsBP = await applyCamposTemplateGeneric(page, "#ModulosSociosDeNegocios", templateObj);
      console.log(`🧩 CAMPOS SOCIOS aplicados. Filas tocadas: ${logsBP.touched}`);

      // APLICAR en ARTÍCULOS (pinta ambas columnas)
      // (asegura tab activo nuevamente)
      try {
        await activateTabByText(page, "Datos de artículos");
      } catch {}
      const logsART = await applyCamposTemplateGeneric(page, "#ModulosArticulos", templateObj);
      console.log(`🧩 DATOS ARTÍCULOS aplicados. Filas tocadas: ${logsART.touched}`);

      // OJO: notFound por container incluye códigos del otro tab; por eso NO lo listamos como error.
      await sleep(500);
      await snapshot(page, outDir, "campos_aplicado_todos");

      // Si quieres automatizar “GUARDAR CAMPOS S. DE NEGOCIOS” / “GUARDAR DATOS DE ARTÍCULOS”
      // lo hacemos después cuando me confirmes el selector exacto o texto del botón visible.
    }
  } catch (e) {
    console.log("⚠️ No se pudo procesar CAMPOS (Socios/Artículos):", e.message || e);
  }

  console.log("Listo ✅");

  if (KEEP_OPEN) {
    console.log("🟢 KEEP_OPEN=true -> navegador quedará abierto.");
    await ask("Presiona ENTER para cerrar el navegador...");
  }

  await browser.close();
})().catch((err) => {
  console.error("Error:", err && err.message ? err.message : err);
  process.exit(1);
});
