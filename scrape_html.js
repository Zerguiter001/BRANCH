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

/* -------------------------------------------------------------------------- */
/* ✅ HELPERS AUTOCOMPLETE (COMMIT REAL + VALIDACIÓN)                          */
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
 * Snapshot (igual)
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
      await sleep(120);
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

      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
    console.log(`⚠️ setInputValueNative fallo en ${selector}:`, ok?.reason || "sin detalle");
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

/**
 * Busca SELECT por label dentro del modal (no depende de IDs duplicados)
 * (Esto sirve para "Tipo de usuario", que sí es <select>)
 */
async function selectInAdminModalByLabel(page, labelIncludes, wantedTextOrValue, { timeout = 20000 } = {}) {
  const wantedNorm = norm(wantedTextOrValue);
  const labelNorm = norm(labelIncludes);

  await page.waitForFunction(() => {
    const modal = document.querySelector("#adminUsersModal.modal.show") || document.querySelector(".modal.show");
    return !!modal;
  }, { timeout });

  const res = await page.evaluate(
    ({ labelNorm, wantedNorm, wantedRaw }) => {
      const modal = document.querySelector("#adminUsersModal.modal.show") || document.querySelector(".modal.show");
      if (!modal) return { ok: false, reason: "No hay modal visible" };

      const norm2 = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const groups = Array.from(modal.querySelectorAll(".form-group, .input-group, .mb-2, .mb-3"));
      const g = groups.find((x) => {
        const lab = x.querySelector("label, .input-group-prepend .input-group-text");
        const sel = x.querySelector("select");
        return lab && sel && norm2(lab.textContent).includes(labelNorm);
      });

      if (!g) return { ok: false, reason: `No se encontró grupo con label ~ "${labelNorm}"` };

      const sel = g.querySelector("select");
      if (!sel) return { ok: false, reason: "No hay select en el grupo" };

      const opts = Array.from(sel.querySelectorAll("option"));

      const wantedLooksValue =
        /^[0-9]+$/.test(String(wantedRaw).trim()) ||
        opts.some((o) => String(o.value) === String(wantedRaw).trim());

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
          available: opts.map((o) => ({ value: o.value, text: (o.textContent || "").trim() })).slice(0, 15),
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

/**
 * ✅ Sucursal AUTOCOMPLETE: COMMIT real (click o Enter) + validación de que quedó.
 * (evita que se quede en "ZONAL")
 *
 * Opcional en .env:
 *   AUTOCOMPLETE_WAIT_MS=900
 */
async function setAutocompleteInAdminModalByLabel(page, labelIncludes, wantedText, { timeout = 25000 } = {}) {
  const labelNorm = norm(labelIncludes);
  const wantedRaw = String(wantedText || "").trim();
  if (!wantedRaw) return;

  await page.waitForFunction(() => {
    const modal = document.querySelector("#adminUsersModal.modal.show") || document.querySelector(".modal.show");
    return !!modal;
  }, { timeout });

  const found = await page.evaluate(({ labelNorm }) => {
    const modal = document.querySelector("#adminUsersModal.modal.show") || document.querySelector(".modal.show");
    if (!modal) return { ok: false, reason: "No hay modal visible" };

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
      return lab && inp && norm2(lab.textContent).includes(labelNorm);
    });

    if (!g) return { ok: false, reason: `No se encontró grupo con label ~ "${labelNorm}"` };

    const inp = g.querySelector('input[type="text"]');
    if (!inp) return { ok: false, reason: "No hay input[type=text] en el grupo" };

    inp.setAttribute("data-autofill", "target");
    return { ok: true };
  }, { labelNorm });

  if (!found.ok) throw new Error(found.reason);

  const inputSel = '#adminUsersModal [data-autofill="target"], .modal.show [data-autofill="target"]';
  await page.waitForSelector(inputSel, { timeout: 15000 });

  const tries = [buildAutocompleteQuery(wantedRaw), wantedRaw];

  try {
    for (let attempt = 0; attempt < tries.length; attempt++) {
      const query = tries[attempt];

      await page.click(inputSel, { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type(inputSel, query, { delay: 35 });

      await sleep(Number(process.env.AUTOCOMPLETE_WAIT_MS || 900));

      // A) intentar click en opción visible
      const clicked = await page.evaluate((wantedRaw) => {
        const norm2 = (s) =>
          String(s || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const wantedNorm = norm2(wantedRaw);
        const tokens = wantedNorm.split(" ").filter(Boolean);

        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };

        const nodes = Array.from(
          document.querySelectorAll(`
            ngb-typeahead-window .dropdown-item,
            ngb-typeahead-window button,
            .dropdown-menu.show .dropdown-item,
            .dropdown-menu.show button,
            typeahead-container button,
            typeahead-container li,
            .typeahead-container button,
            .typeahead-container li,
            ul[role="listbox"] [role="option"],
            [role="option"],
            .ng-dropdown-panel .ng-option,
            .mat-autocomplete-panel mat-option,
            .autocomplete-items * ,
            .autocomplete-suggestions *
          `)
        ).filter(isVisible);

        const score = (el) => {
          const t = norm2(el.textContent || "");
          if (!t) return 0;
          let s = 0;
          for (const tok of tokens) if (t.includes(tok)) s++;
          if (wantedNorm && t.includes(wantedNorm)) s += 2;
          if (wantedNorm && t === wantedNorm) s += 3;
          return s;
        };

        let best = null, bestScore = 0;
        for (const el of nodes) {
          const sc = score(el);
          if (sc > bestScore) {
            best = el;
            bestScore = sc;
          }
        }

        if (!best || bestScore === 0) return { ok: false, count: nodes.length };

        best.scrollIntoView({ block: "center" });
        best.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        best.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        best.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        return { ok: true, text: (best.textContent || "").trim(), score: bestScore };
      }, wantedRaw);

      if (clicked.ok) {
        await sleep(300);
      } else {
        // B) fallback: ArrowDown + Enter (muchos autocompletes solo comitean así)
        for (let k = 0; k < 6; k++) {
          await page.keyboard.press("ArrowDown");
          await sleep(80);
          await page.keyboard.press("Enter");
          await sleep(350);

          const val = await page.$eval(inputSel, (el) => el.value || "");
          if (valueMatchesAllTokens(val, wantedRaw)) break;
        }
      }

      // validar que quedó seleccionado
      const finalVal = await page.$eval(inputSel, (el) => el.value || "");
      if (valueMatchesAllTokens(finalVal, wantedRaw)) {
        // blur para que el UI aplique dependencias
        await page.keyboard.press("Tab");
        await sleep(200);

        const afterBlur = await page.$eval(inputSel, (el) => el.value || "");
        if (valueMatchesAllTokens(afterBlur, wantedRaw)) {
          console.log(`✅ Sucursal COMMIT OK: "${afterBlur}"`);
          return;
        }
      }
    }

    throw new Error(`❌ No se pudo COMMIT-ejar la sucursal "${wantedRaw}" (se queda en valor inválido/por defecto).`);
  } finally {
    // Limpia el marcador SIEMPRE
    await page.evaluate(() => {
      const el = document.querySelector('[data-autofill="target"]');
      if (el) el.removeAttribute("data-autofill");
    });
  }
}

// Tipo usuario (por label) => SELECT
async function selectTipoUsuario(page) {
  const wanted = (process.env.NEW_USER_TIPO || "BRANCH").trim();
  const r = await selectInAdminModalByLabel(page, "tipo de usuario", wanted, { timeout: 25000 });
  console.log(`✅ Tipo de usuario: ${r.text} (value=${r.value})`);
}

// ✅ Sucursal (AUTOCOMPLETE INPUT) => COMMIT real
async function selectSucursal(page) {
  const textEnv = (process.env.NEW_USER_SUCURSAL || "").trim();        // ej: "ZONAL BOLOGNESI"
  const valueEnv = (process.env.NEW_USER_SUCURSAL_VALUE || "").trim(); // fallback (si lo usas)

  const wanted = textEnv || valueEnv;
  if (!wanted) {
    console.log("ℹ️ NEW_USER_SUCURSAL vacío -> no selecciona Sucursal.");
    return;
  }

  await setAutocompleteInAdminModalByLabel(page, "sucursal", wanted, { timeout: 25000 });
  console.log(`✅ Sucursal seteada (autocomplete, texto pedido): ${wanted}`);
}

// Forzar valor estable para código (por si el UI lo pisa)
async function forceStableValueInModal(page, selector, value, { tries = 6, waitMs = 220 } = {}) {
  for (let i = 1; i <= tries; i++) {
    await page.evaluate(({ selector, value }) => {
      const modal = document.querySelector("#adminUsersModal.modal.show") || document.querySelector(".modal.show");
      if (!modal) throw new Error("No hay modal visible");

      const el = modal.querySelector(selector);
      if (!el) throw new Error("No existe selector en modal: " + selector);

      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
      const modal = document.querySelector("#adminUsersModal.modal.show") || document.querySelector(".modal.show");
      const el = modal ? modal.querySelector(selector) : null;
      return el ? (el.value || "") : null;
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

  await page.waitForFunction(() => {
    const m = document.querySelector("#adminUsersModal.modal.show") || document.querySelector(".modal.show");
    return !!m;
  }, { timeout: 30000 });

  // 1) Tipo usuario (SELECT)
  await selectTipoUsuario(page);

  // 2) Sucursal (AUTOCOMPLETE INPUT) ✅ COMMIT
  await selectSucursal(page);

  // pequeña pausa para que el UI aplique dependencias
  await sleep(350);

  // 3) Nombre / Correo
  if (NAME) await setInputValueNative(page, "#User_U_NAME", NAME);
  if (EMAIL) await setInputValueNative(page, "#User_E_Mail", EMAIL);

  // 4) Código (forzado)
  if (CODE) await forceStableValueInModal(page, "#User_USER_CODE", CODE);

  // 5) Contraseñas por label "contraseña" dentro del modal
  if (PASS) {
    const done = await page.evaluate((PASS) => {
      const modal = document.querySelector("#adminUsersModal.modal.show") || document.querySelector(".modal.show") || document;
      const norm2 = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const groups = Array.from(modal.querySelectorAll(".input-group, .form-group"));
      const passGroups = groups.filter((g) => {
        const lab = g.querySelector("label, .input-group-prepend .input-group-text");
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

    console.log(`✅ Contraseñas seteadas en ${done.count} input(s)`);
  } else {
    console.log("ℹ️ NEW_USER_PASS vacío -> no se setea contraseña.");
  }

  console.log("✅ Modal Crear usuario llenado (Tipo por SELECT + Sucursal por AUTOCOMPLETE + Código estable).");
}

/* -------------------------------------------------------------------------- */
/* FIX: CLICK GUARDAR MÁS RÁPIDO                                               */
/* -------------------------------------------------------------------------- */

// Click rápido: intenta inmediato y si no está, espera poco y reintenta
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

// Click del botón (fa-list) "Módulos" SOLO SI NO ESTÁ ABIERTO
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

// ✅ CLICK GUARDAR MÓDULOS MÁS RÁPIDO (no espera cierre)
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
/* TABS                                                                         */
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
/* CREAR (botón final)                                                         */
/* -------------------------------------------------------------------------- */

async function clickCrearUsuarioSiCorresponde(page) {
  const AUTO_CREATE = String(process.env.AUTO_CREATE || "false").toLowerCase() === "true";
  if (!AUTO_CREATE) {
    console.log("ℹ️ AUTO_CREATE=false -> NO se hace click en 'Crear'.");
    return;
  }

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
}

/* -------------------------------------------------------------------------- */
/* MAIN                                                                        */
/* -------------------------------------------------------------------------- */

(async () => {
  const BASE_URL = process.env.SCRAPE_URL || "https://sap2.llamagas.nubeprivada.biz/";
  const USER = process.env.LOGIN_USER;
  const PASS = process.env.LOGIN_PASS;

  const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() === "true";
  const KEEP_OPEN = String(process.env.KEEP_OPEN || "false").toLowerCase() === "true";
  const AUTO_SAVE_CAMPOS = String(process.env.AUTO_SAVE_CAMPOS || "true").toLowerCase() === "true";

  const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1536", 10);
  const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "864", 10);
  const DEVICE_SCALE_FACTOR = parseFloat(process.env.DEVICE_SCALE_FACTOR || "1");

  const PERMISOS_DIR = path.join(process.cwd(), "permisos_modulos");
  const envFile = (process.env.PERMISOS_FILE || "").trim();
  const permisosFileName = envFile || "branch.json";
  const permisosPath = path.join(PERMISOS_DIR, path.basename(permisosFileName));

  const CAMPOS_DIR = path.join(process.cwd(), "permisos_campossap");
  const camposEnvFile = (process.env.CAMPOS_FILE || "").trim();
  const camposFileName = camposEnvFile || "branch.json";
  const camposPath = path.join(CAMPOS_DIR, path.basename(camposFileName));

  if (!USER || !PASS) throw new Error("Faltan LOGIN_USER o LOGIN_PASS en tu .env");

  const outDir = path.join(process.cwd(), "HTML");
  await fs.ensureDir(outDir);
  await fs.ensureDir(PERMISOS_DIR);
  await fs.ensureDir(CAMPOS_DIR);

  console.log("📁 Ruta módulos :", permisosPath);
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
    console.log("2FA detectado. Ingresa el código de 6 dígitos del correo.");
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

  // Crear usuario
  const crearBtnSel = 'button.btn.btn-outline-secondary.btn-timbra-one.mr-sm-3';
  try {
    await page.waitForSelector(crearBtnSel, { timeout: 15000 });
    await page.click(crearBtnSel);
  } catch {
    await clickByText(page, "Crear usuario", { timeout: 20000 });
  }

  await sleep(900);
  await snapshot(page, outDir, "crearUsuario");

  // Llenar inputs + Tipo + Sucursal(AUTOCOMPLETE) + Contraseñas
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
    } catch {}
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
      } catch {}
      const logsART = await applyCamposTemplateGeneric(page, "#ModulosArticulos", templateObj);
      console.log(`🧩 DATOS ARTÍCULOS aplicados. Filas tocadas: ${logsART.touched}`);

      await sleep(250);
      await snapshot(page, outDir, "campos_aplicado_todos");

      if (AUTO_SAVE_CAMPOS) {
        try {
          await activateTabByText(page, "Campos SAP");
        } catch {}
        await clickButtonInContainerByText(page, "#ModulosSociosDeNegocios", "GUARDAR CAMPOS S. DE NEGOCIOS", {
          timeout: 12000,
        });
        await sleep(Number(process.env.SAVE_WAIT_MS || 600));
        await snapshot(page, outDir, "guardar_campos_socios");

        try {
          await activateTabByText(page, "Datos de artículos");
        } catch {}
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
  // ✅ CREAR (según .env)
  // ----------------------
  await clickCrearUsuarioSiCorresponde(page);
  await sleep(800);
  await snapshot(page, outDir, "post_crear_si_corresponde");

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
