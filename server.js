// server.js (CommonJS)
// ----------------------------------------------------------------------------
// Sirve index.html + API para templates + Jobs que ejecutan scrape_html.js
// ----------------------------------------------------------------------------
require("dotenv").config();

const path = require("path");
const fs = require("fs-extra");
const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 3008);
const CWD = process.cwd();

const PERMISOS_DIR = path.join(CWD, "permisos_modulos");
const RUNS_DIR = path.join(CWD, "RUNS");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB
});

const jobs = new Map(); // jobId -> jobState (en memoria)

// -------------------------- Helpers --------------------------

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

function safeJsonBasename(name) {
  const b = path.basename(String(name || "")).trim();
  if (!b) return "";
  if (!b.toLowerCase().endsWith(".json")) return "";
  // evita traversal: basename ya lo recorta
  return b;
}

function safeName(name) {
  return String(name || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function userTagFromCode(code) {
  return String(code || "").replace(/[^\w.-]+/g, "_");
}

function parseImportantLine(line) {
  // ejemplo:
  // [2025-12-10T21:45:59.210Z] [IMPORTANT] 🚀 Inicio RUN | {"RUN_ID":"...","LOG_FILE":"..."}
  const m = String(line || "").match(/\] \[IMPORTANT\]\s+(.*?)(?:\s+\|\s+(.*))?$/);
  if (!m) return null;
  const msg = (m[1] || "").trim();
  let extra = null;
  if (m[2]) {
    try {
      extra = JSON.parse(m[2]);
    } catch {
      extra = null;
    }
  }
  return { msg, extra };
}

async function ensureDirs() {
  await fs.ensureDir(PERMISOS_DIR);
  await fs.ensureDir(RUNS_DIR);
}

function jobFilePath(jobId) {
  return path.join(RUNS_DIR, jobId, "job.json");
}

async function persistJob(job) {
  try {
    await fs.ensureDir(path.join(RUNS_DIR, job.id));
    await fs.writeJson(jobFilePath(job.id), job, { spaces: 2 });
  } catch {}
}

async function loadJobFromDisk(jobId) {
  try {
    const p = jobFilePath(jobId);
    if (!(await fs.pathExists(p))) return null;
    return await fs.readJson(p);
  } catch {
    return null;
  }
}

function touchJob(job, patch = {}) {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(job.id, next);
  persistJob(next).catch(() => {});
  return next;
}

function normalizeTemplateToArray(raw) {
  // Acepta:
  // 1) Array: [{title,activo,escritura}, ...]
  // 2) Object: { "Titulo": {activo,escritura}, ... }
  if (Array.isArray(raw)) {
    return raw
      .map((x) => ({
        title: String(x?.title ?? x?.titulo ?? "").trim(),
        activo: !!x?.activo,
        escritura: !!x?.escritura,
      }))
      .filter((x) => x.title);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .map(([title, v]) => ({
        title: String(title || "").trim(),
        activo: !!v?.activo,
        escritura: !!v?.escritura,
      }))
      .filter((x) => x.title);
  }
  return [];
}

function arrayToTemplateObject(arr) {
  const out = {};
  for (const it of Array.isArray(arr) ? arr : []) {
    const title = String(it?.title || "").trim();
    if (!title) continue;
    out[title] = { activo: !!it.activo, escritura: !!it.escritura };
  }
  return out;
}

function extractRowLog(fullText, rowIndex) {
  // intenta partir por bloques usando "👤 (k/...) PROCESANDO"
  const lines = String(fullText || "").split(/\r?\n/);
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("👤 (") && lines[i].includes(") PROCESANDO")) markers.push(i);
  }
  if (!markers.length) return fullText;

  const idx = Number(rowIndex);
  // el rowIndex del front es 1-based (1..N)
  const markerPos = markers[idx - 1];
  if (markerPos === undefined) return fullText;

  const nextMarkerPos = markers[idx] ?? lines.length;
  return lines.slice(markerPos, nextMarkerPos).join("\n");
}

// -------------------------- UI --------------------------

app.get("/", async (_req, res) => {
  return res.sendFile(path.join(CWD, "index.html"));
});

// -------------------------- Templates (Permisos) --------------------------

app.get("/api/templates/permisos", async (_req, res) => {
  await ensureDirs();
  try {
    const files = (await fs.readdir(PERMISOS_DIR))
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
    return res.json({ ok: true, files });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/api/templates/permisos/:file", async (req, res) => {
  await ensureDirs();
  const file = safeJsonBasename(req.params.file);
  if (!file) return res.status(400).json({ ok: false, error: "Archivo inválido" });

  const full = path.join(PERMISOS_DIR, file);
  if (!(await fs.pathExists(full))) return res.status(404).json({ ok: false, error: "No existe" });

  try {
    const raw = await fs.readJson(full);
    const data = normalizeTemplateToArray(raw);
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.put("/api/templates/permisos/:file", async (req, res) => {
  await ensureDirs();
  const file = safeJsonBasename(req.params.file);
  if (!file) return res.status(400).json({ ok: false, error: "Archivo inválido" });

  const full = path.join(PERMISOS_DIR, file);
  if (!(await fs.pathExists(full))) return res.status(404).json({ ok: false, error: "No existe" });

  try {
    const data = req.body?.data;
    const obj = arrayToTemplateObject(data);
    await fs.writeJson(full, obj, { spaces: 2 });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.delete("/api/templates/permisos/:file", async (req, res) => {
  await ensureDirs();
  const file = safeJsonBasename(req.params.file);
  if (!file) return res.status(400).json({ ok: false, error: "Archivo inválido" });

  const full = path.join(PERMISOS_DIR, file);
  if (!(await fs.pathExists(full))) return res.status(404).json({ ok: false, error: "No existe" });

  try {
    await fs.remove(full);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/templates/permisos", async (req, res) => {
  await ensureDirs();
  try {
    const name = safeName(req.body?.name);
    const data = req.body?.data;

    if (!name) return res.status(400).json({ ok: false, error: "Nombre inválido" });

    const base = `${ts()}_${name}.json`;
    const filename = base;
    const full = path.join(PERMISOS_DIR, filename);

    const obj = arrayToTemplateObject(data);
    await fs.writeJson(full, obj, { spaces: 2 });

    return res.json({ ok: true, filename });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// -------------------------- Jobs --------------------------

app.post("/api/jobs", upload.single("excel"), async (req, res) => {
  await ensureDirs();

  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Falta archivo excel" });

    const permisosFile = safeJsonBasename(req.body?.permisosFile);
    if (!permisosFile) return res.status(400).json({ ok: false, error: "permisosFile inválido" });

    const autoCreate = String(req.body?.autoCreate || "true").toLowerCase() === "true";
    const headless = String(req.body?.headless || "true").toLowerCase() === "true";
    const otpCode = String(req.body?.otpCode || "").trim(); // opcional

    const jobId = `${ts()}_${crypto.randomBytes(3).toString("hex")}`;
    const jobDir = path.join(RUNS_DIR, jobId);
    await fs.ensureDir(jobDir);

    const excelPath = path.join(jobDir, "data.xlsx");
    await fs.writeFile(excelPath, req.file.buffer);

    let job = {
      id: jobId,
      status: "queued", // queued | running | done | error
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),

      totalRows: 0,
      doneRows: 0,
      results: [], // [{index, code, status, rowDir, error?}]

      // Info detectada desde logs del script:
      runId: null,
      outDir: null,
      logFile: null,

      error: null,
    };

    jobs.set(jobId, job);
    await persistJob(job);

    // Spawn scrape_html.js
    const childEnv = {
      ...process.env,
      EXCEL_MASIVO: "true",
      EXCEL_FILE: excelPath,
      PERMISOS_FILE: permisosFile,
      AUTO_CREATE: autoCreate ? "true" : "false",
      HEADLESS: headless ? "true" : "false",
      KEEP_OPEN: "false",

      // Aísla logs por job:
      LOG_DIR: path.join("RUNS", jobId, "LOGS"),
      CONSOLE_LEVEL: "important",

      // 2FA opcional (ver parche en scrape_html.js abajo)
      OTP_CODE: otpCode || process.env.OTP_CODE || "",
    };

    const child = spawn(process.execPath, [path.join(CWD, "scrape_html.js")], {
      cwd: CWD,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    job = touchJob(job, { status: "running" });

    // parsea stdout/stderr para progreso
    let bufOut = "";
    let bufErr = "";

    const handleLine = (line) => {
      const parsed = parseImportantLine(line);
      if (!parsed) return;

      const { msg, extra } = parsed;

      // Detecta RUN_ID / LOG_FILE
      if (msg.startsWith("🚀 Inicio RUN") && extra) {
        job = touchJob(job, { runId: extra.RUN_ID || job.runId, logFile: extra.LOG_FILE || job.logFile });
        return;
      }

      // outDir
      if (msg.startsWith("📁 Output") && extra) {
        job = touchJob(job, { outDir: extra.outDir || job.outDir });
        return;
      }

      // Excel leído
      if (msg.startsWith("📄 Excel leído") && extra) {
        const total = Number(extra.usuarios_validos ?? 0);
        if (total > 0) job = touchJob(job, { totalRows: total });
        return;
      }

      // PROCESANDO
      if (msg.startsWith("👤 (") && msg.includes(") PROCESANDO")) {
        // "👤 (k/total) PROCESANDO"
        const m = msg.match(/👤 \((\d+)\/(\d+)\)\s+PROCESANDO/);
        const idx = m ? Number(m[1]) : null;
        const total = m ? Number(m[2]) : null;

        const code = extra?.code || "";
        const tag = userTagFromCode(code);

        const rowDir =
          job.outDir && idx
            ? path.join(job.outDir, `user_${pad3(idx)}_${tag}`)
            : "";

        const results = Array.isArray(job.results) ? [...job.results] : [];
        const existing = results.find((r) => r.index === idx);
        if (existing) {
          existing.status = "running";
          existing.code = code || existing.code;
          existing.rowDir = rowDir || existing.rowDir;
          existing.error = null;
        } else if (idx) {
          results.push({ index: idx, code, status: "running", rowDir });
        }

        results.sort((a, b) => a.index - b.index);

        const patch = { results };
        if (total && total > 0 && (!job.totalRows || job.totalRows < total)) patch.totalRows = total;
        job = touchJob(job, patch);
        return;
      }

      // OK
      if (msg.startsWith("✅ OK usuario")) {
        // marca último "running" como ok
        const results = Array.isArray(job.results) ? [...job.results] : [];
        const r = results.find((x) => x.status === "running") || results[results.length - 1];
        if (r) r.status = "ok";
        const done = Number(job.doneRows || 0) + 1;
        job = touchJob(job, { results, doneRows: done });
        return;
      }

      // FAIL
      if (msg.startsWith("❌ FAIL usuario")) {
        const results = Array.isArray(job.results) ? [...job.results] : [];
        const r = results.find((x) => x.status === "running") || results[results.length - 1];
        if (r) {
          r.status = "error";
          r.error = extra?.error || "FAIL";
        }
        const done = Number(job.doneRows || 0) + 1;
        job = touchJob(job, { results, doneRows: done });
        return;
      }

      // Error fatal
      if (msg.startsWith("💥 Error fatal")) {
        job = touchJob(job, { status: "error", error: extra?.error || "Error fatal" });
        return;
      }
    };

    child.stdout.on("data", (chunk) => {
      bufOut += chunk.toString("utf8");
      const parts = bufOut.split(/\r?\n/);
      bufOut = parts.pop() || "";
      parts.forEach(handleLine);
    });

    child.stderr.on("data", (chunk) => {
      bufErr += chunk.toString("utf8");
      const parts = bufErr.split(/\r?\n/);
      bufErr = parts.pop() || "";
      // también intenta parsear IMPORTANT si sale por stderr
      parts.forEach(handleLine);
    });

    child.on("close", (code) => {
      const j = jobs.get(jobId) || job;
      if (j.status === "error") return; // ya marcado
      if (code === 0) {
        touchJob(j, { status: "done" });
      } else {
        touchJob(j, { status: "error", error: `Proceso terminó con code=${code}` });
      }
    });

    return res.json({ ok: true, jobId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/api/jobs/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  let job = jobs.get(id);
  if (!job) job = await loadJobFromDisk(id);
  if (!job) return res.status(404).json({ ok: false, error: "Job no existe" });
  return res.json({ ok: true, job });
});

app.get("/api/jobs/:id/row/:index/log", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const index = Number(req.params.index || 0);

  let job = jobs.get(id);
  if (!job) job = await loadJobFromDisk(id);
  if (!job) return res.status(404).send("Job no existe");

  // logFile puede venir del propio script (LOG_FILE). Si aún no existe, intenta buscarlo.
  let logFile = job.logFile;
  if (!logFile) {
    // fallback: RUNS/<jobId>/LOGS/*/run.log
    const base = path.join(RUNS_DIR, id, "LOGS");
    try {
      if (await fs.pathExists(base)) {
        const dirs = (await fs.readdir(base)).filter((d) => d.startsWith("run_"));
        if (dirs.length) {
          const candidate = path.join(base, dirs.sort().slice(-1)[0], "run.log");
          if (await fs.pathExists(candidate)) logFile = candidate;
        }
      }
    } catch {}
  }

  if (!logFile || !(await fs.pathExists(logFile))) return res.status(404).send("No hay log aún");

  const txt = await fs.readFile(logFile, "utf8");
  const out = index > 0 ? extractRowLog(txt, index) : txt;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send(out);
});

// -------------------------- Start --------------------------

app.listen(PORT, async () => {
  await ensureDirs();
  console.log(`✅ UI corriendo en: http://localhost:${PORT}`);
});
