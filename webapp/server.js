// webapp/server.js
const path = require("path");

// ✅ ROOT REAL del proyecto (padre de /webapp), aunque ejecutes "node webapp/server.js"
const ROOT = process.env.ROOT_DIR
  ? path.resolve(process.env.ROOT_DIR)
  : path.resolve(__dirname, "..");

// ✅ Carga .env desde la RAÍZ del proyecto
require("dotenv").config({ path: path.join(ROOT, ".env") });

const express = require("express");
const cors = require("cors");
const fs = require("fs-extra");
const multer = require("multer");
const XLSX = require("xlsx");
const PQueue = require("p-queue").default;
const lockfile = require("proper-lockfile");
const { spawn } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ---------- CONFIG ----------
const SCRAPER_PATH = process.env.SCRAPER_PATH
  ? path.resolve(process.env.SCRAPER_PATH)
  : path.join(ROOT, "scrape_html.js");

const RUNS_DIR = process.env.RUNS_DIR
  ? path.resolve(process.env.RUNS_DIR)
  : path.join(ROOT, "RUNS");

const LIB_PERMISOS_DIR = process.env.LIB_PERMISOS_DIR
  ? path.resolve(process.env.LIB_PERMISOS_DIR)
  : path.join(ROOT, "permisos_modulos");

const LIB_CAMPOS_DIR = process.env.LIB_CAMPOS_DIR
  ? path.resolve(process.env.LIB_CAMPOS_DIR)
  : path.join(ROOT, "permisos_campossap");

const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS || "1");

// ⚠️ Credenciales viven en el SERVER (.env), NO en el frontend.
const LOGIN_USER = process.env.LOGIN_USER;
const LOGIN_PASS = process.env.LOGIN_PASS;
const SCRAPE_URL = process.env.SCRAPE_URL;

// Cola global para que no se abran 20 Chromes a la vez
const queue = new PQueue({ concurrency: MAX_CONCURRENT_RUNS });

// jobs in-memory + persist simple
const JOBS_FILE = path.join(RUNS_DIR, "jobs.json");
let JOBS = {}; // { jobId: {...} }

function nowISO() {
  return new Date().toISOString();
}

function uid() {
  return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

async function loadJobs() {
  await fs.ensureDir(RUNS_DIR);
  if (await fs.pathExists(JOBS_FILE)) {
    JOBS = await fs.readJson(JOBS_FILE).catch(() => ({}));
  }
}

async function saveJobs() {
  await fs.ensureDir(RUNS_DIR);
  await fs.writeJson(JOBS_FILE, JOBS, { spaces: 2 });
}

function slugify(s) {
  return (
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "template"
  );
}

function parseTemplateNumber(filename) {
  const m = /^(\d+)_/.exec(filename);
  return m ? Number(m[1]) : null;
}

async function listJsonFiles(dir) {
  await fs.ensureDir(dir);
  const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json"));
  files.sort((a, b) => (parseTemplateNumber(a) ?? 1e12) - (parseTemplateNumber(b) ?? 1e12));
  return files;
}

// Excel: mapea columnas comunes a tu ENV
function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase();
}

function rowToEnv(rowObj) {
  const get = (...keys) => {
    for (const k of keys) {
      const v = rowObj[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  };

  const env = {
    NEW_USER_SUCURSAL: get("new_user_sucursal", "sucursal", "branch", "sede"),
    NEW_USER_CODE: get("new_user_code", "code", "codigo", "user_code"),
    NEW_USER_NAME: get("new_user_name", "name", "nombre"),
    NEW_USER_EMAIL: get("new_user_email", "email", "correo"),
    NEW_USER_PASS: get("new_user_pass", "pass", "password", "clave"),
    NEW_USER_TIPO: get("new_user_tipo", "tipo", "type"),
    NEW_USER_COUNTER_ROL: get("new_user_counter_rol", "counter_rol", "rol_caja", "rol"),
    PERMISOS_FILE: get("permisos_file", "perfil_permisos"),
    CAMPOS_FILE: get("campos_file", "perfil_campos"),
  };

  Object.keys(env).forEach((k) => {
    if (!env[k]) delete env[k];
  });

  return env;
}

function readExcelRows(excelPath) {
  const wb = XLSX.readFile(excelPath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const rows = json.map((obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[normalizeHeader(k)] = v;
    return out;
  });

  return rows;
}

async function copyIfExists(src, dst) {
  if (!src) return;
  const s = path.resolve(src);
  if (await fs.pathExists(s)) await fs.copy(s, dst);
}

// ejecuta scrape_html.js como proceso hijo, capturando stdout/stderr a un log
function runScraperOnce({ env, logFile }) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logFile, { flags: "a" });
    out.write(`\n====================\nSTART ${nowISO()}\n====================\n`);

    const child = spawn(process.execPath, [SCRAPER_PATH], {
      env,
      cwd: ROOT, // ✅ importante: el scraper corre en la raíz real del proyecto
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d) => out.write(d));
    child.stderr.on("data", (d) => out.write(d));

    child.on("close", (code) => {
      out.write(`\n====================\nEND ${nowISO()} (exit=${code})\n====================\n`);
      out.end();
      resolve({ code });
    });
  });
}

async function processJob(jobId) {
  const job = JOBS[jobId];
  if (!job) return;

  job.status = "running";
  job.startedAt = nowISO();
  await saveJobs();

  const jobDir = path.join(RUNS_DIR, jobId);
  await fs.ensureDir(jobDir);

  const excelPath = job.excelPath;
  let rows;
  try {
    rows = readExcelRows(excelPath);
  } catch (e) {
    job.status = "error";
    job.error = "No se pudo leer Excel: " + (e.message || e);
    job.endedAt = nowISO();
    await saveJobs();
    return;
  }

  job.totalRows = rows.length;
  job.results = [];
  await saveJobs();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowEnv = rowToEnv(row);

    const code = rowEnv.NEW_USER_CODE || `row_${i + 1}`;
    const rowSlug = slugify(code);
    const rowDir = path.join(jobDir, `row_${String(i + 1).padStart(3, "0")}_${rowSlug}`);

    await fs.ensureDir(rowDir);

    const rowPermDir = path.join(rowDir, "permisos_modulos");
    const rowCamposDir = path.join(rowDir, "permisos_campossap");
    const rowHtmlDir = path.join(rowDir, "HTML");
    const rowLogDir = path.join(rowDir, "LOGS");

    await fs.ensureDir(rowPermDir);
    await fs.ensureDir(rowCamposDir);
    await fs.ensureDir(rowHtmlDir);
    await fs.ensureDir(rowLogDir);

    const permisosFile = rowEnv.PERMISOS_FILE || job.defaults.permisosFile || "";
    const camposFile = rowEnv.CAMPOS_FILE || job.defaults.camposFile || "";

    if (permisosFile) {
      await copyIfExists(
        path.join(LIB_PERMISOS_DIR, path.basename(permisosFile)),
        path.join(rowPermDir, path.basename(permisosFile))
      );
    }
    if (camposFile) {
      await copyIfExists(
        path.join(LIB_CAMPOS_DIR, path.basename(camposFile)),
        path.join(rowCamposDir, path.basename(camposFile))
      );
    }

    const logFile = path.join(rowLogDir, "terminal.log");

    const env = {
      ...process.env,

      // credenciales y url
      SCRAPE_URL,
      LOGIN_USER,
      LOGIN_PASS,

      // ✅ aislamiento real para el scraper
      JOB_OUTPUT_DIR: rowDir,
      PERMISOS_DIR: rowPermDir,
      CAMPOS_DIR: rowCamposDir,
      HTML_DIR_NAME: "HTML",
      LOG_DIR: rowLogDir, // ✅ así el scraper loguea aquí

      // ✅ FIX CLAVE: NUNCA permitir que el scraper use modo Excel cuando lo llamas desde la WebApp
      EXCEL_MASIVO: "false",
      EXCEL_FILE: "",

      // defaults UI
      AUTO_CREATE: String(job.defaults.autoCreate ? "true" : "false"),
      HEADLESS: String(job.defaults.headless ? "true" : "false"),
      KEEP_OPEN: "false",
    };

    if (permisosFile) env.PERMISOS_FILE = path.basename(permisosFile);
    if (camposFile) env.CAMPOS_FILE = path.basename(camposFile);

    // aplica los valores de la fila (NEW_USER_*)
    Object.assign(env, rowEnv);

    // ✅ Blindaje extra (por si algo reinyecta flags)
    env.EXCEL_MASIVO = "false";
    env.EXCEL_FILE = "";

    const required = ["NEW_USER_CODE", "NEW_USER_NAME", "NEW_USER_EMAIL", "NEW_USER_TIPO"];
    const missing = required.filter((k) => !env[k]);
    const started = nowISO();

    if (missing.length) {
      job.results.push({
        index: i + 1,
        code,
        status: "skipped",
        reason: "Faltan columnas: " + missing.join(", "),
        rowDir,
        startedAt: started,
        endedAt: nowISO(),
      });
      job.doneRows = job.results.length;
      await saveJobs();
      continue;
    }

    const { code: exitCode } = await runScraperOnce({ env, logFile });

    job.results.push({
      index: i + 1,
      code,
      status: exitCode === 0 ? "ok" : "error",
      exitCode,
      rowDir,
      startedAt: started,
      endedAt: nowISO(),
    });

    job.doneRows = job.results.length;
    await saveJobs();
  }

  job.status = "done";
  job.endedAt = nowISO();
  await saveJobs();
}

// ---------- STATIC FRONT ----------
app.use("/", express.static(path.join(__dirname, "public")));

// ✅ Debug rápido de rutas (para que veas dónde está leyendo templates)
app.get("/api/health", async (req, res) => {
  const permisosFiles = await listJsonFiles(LIB_PERMISOS_DIR);
  const camposFiles = await listJsonFiles(LIB_CAMPOS_DIR);
  res.json({
    ok: true,
    ROOT,
    SCRAPER_PATH,
    RUNS_DIR,
    LIB_PERMISOS_DIR,
    LIB_CAMPOS_DIR,
    permisos_count: permisosFiles.length,
    campos_count: camposFiles.length,
    server_EXCEL_MASIVO: process.env.EXCEL_MASIVO || null,
  });
});

// ---------- MULTER ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await fs.ensureDir(RUNS_DIR);
      cb(null, RUNS_DIR);
    },
    filename: (req, file, cb) => {
      const id = uid();
      const ext = path.extname(file.originalname || ".xlsx") || ".xlsx";
      cb(null, `upload_${id}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ---------- JOB API ----------
app.post("/api/jobs", upload.single("excel"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Falta archivo Excel" });
    if (!LOGIN_USER || !LOGIN_PASS || !SCRAPE_URL) {
      return res
        .status(500)
        .json({ ok: false, error: "Faltan LOGIN_USER/LOGIN_PASS/SCRAPE_URL en .env del servidor" });
    }
    if (!(await fs.pathExists(SCRAPER_PATH))) {
      return res.status(500).json({ ok: false, error: "No existe scrape_html.js en la ruta configurada" });
    }

    const jobId = uid();
    const jobDir = path.join(RUNS_DIR, jobId);
    await fs.ensureDir(jobDir);

    const excelPath = path.join(jobDir, path.basename(req.file.path));
    await fs.move(req.file.path, excelPath, { overwrite: true });

    const defaults = {
      permisosFile: String(req.body.permisosFile || "").trim(),
      camposFile: String(req.body.camposFile || "").trim(),
      autoCreate: String(req.body.autoCreate || "false").toLowerCase() === "true",
      headless: String(req.body.headless || "false").toLowerCase() === "true",
    };

    JOBS[jobId] = {
      id: jobId,
      status: "queued",
      createdAt: nowISO(),
      startedAt: null,
      endedAt: null,
      excelPath,
      defaults,
      totalRows: 0,
      doneRows: 0,
      results: [],
    };

    await saveJobs();

    queue.add(() => processJob(jobId)).catch(async (e) => {
      JOBS[jobId].status = "error";
      JOBS[jobId].error = String(e.message || e);
      JOBS[jobId].endedAt = nowISO();
      await saveJobs();
    });

    res.json({ ok: true, jobId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/jobs/:id", async (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.status(404).json({ ok: false, error: "Job no existe" });
  res.json({ ok: true, job });
});

app.get("/api/jobs/:id/row/:rowIndex/log", async (req, res) => {
  const job = JOBS[req.params.id];
  if (!job) return res.status(404).send("Job no existe");
  const idx = Number(req.params.rowIndex);
  const r = job.results.find((x) => x.index === idx);
  if (!r) return res.status(404).send("Row no existe");

  const logFile = path.join(r.rowDir, "LOGS", "terminal.log");
  if (!(await fs.pathExists(logFile))) return res.status(404).send("Log no existe");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(await fs.readFile(logFile, "utf8"));
});

// ---------- TEMPLATES API (PERMISOS) ----------
app.get("/api/templates/permisos", async (req, res) => {
  const files = await listJsonFiles(LIB_PERMISOS_DIR);
  res.json({ ok: true, files });
});

app.get("/api/templates/permisos/:file", async (req, res) => {
  const file = path.basename(req.params.file);
  const p = path.join(LIB_PERMISOS_DIR, file);
  if (!(await fs.pathExists(p))) return res.status(404).json({ ok: false, error: "No existe" });
  const data = await fs.readJson(p);
  res.json({ ok: true, data });
});

app.post("/api/templates/permisos", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const data = req.body.data;
  if (!name) return res.status(400).json({ ok: false, error: "Falta name" });
  if (!data) return res.status(400).json({ ok: false, error: "Falta data" });

  await fs.ensureDir(LIB_PERMISOS_DIR);
  const release = await lockfile.lock(LIB_PERMISOS_DIR, { retries: 10 }).catch(() => null);

  try {
    const files = await listJsonFiles(LIB_PERMISOS_DIR);
    const maxN = files
      .map(parseTemplateNumber)
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0);

    const nextN = maxN + 1;
    const filename = `${nextN}_${slugify(name)}.json`;
    const p = path.join(LIB_PERMISOS_DIR, filename);

    await fs.writeJson(p, data, { spaces: 2 });
    res.json({ ok: true, filename });
  } finally {
    if (release) await release();
  }
});

app.put("/api/templates/permisos/:file", async (req, res) => {
  const file = path.basename(req.params.file);
  const p = path.join(LIB_PERMISOS_DIR, file);
  if (!(await fs.pathExists(p))) return res.status(404).json({ ok: false, error: "No existe" });

  const release = await lockfile.lock(p, { retries: 10 }).catch(() => null);
  try {
    await fs.writeJson(p, req.body.data, { spaces: 2 });
    res.json({ ok: true });
  } finally {
    if (release) await release();
  }
});

app.delete("/api/templates/permisos/:file", async (req, res) => {
  const file = path.basename(req.params.file);
  const p = path.join(LIB_PERMISOS_DIR, file);
  if (!(await fs.pathExists(p))) return res.status(404).json({ ok: false, error: "No existe" });

  const release = await lockfile.lock(p, { retries: 10 }).catch(() => null);
  try {
    await fs.remove(p);
    res.json({ ok: true });
  } finally {
    if (release) await release();
  }
});

// ---------- BOOT ----------
(async () => {
  await loadJobs();
  await fs.ensureDir(RUNS_DIR);
  await fs.ensureDir(LIB_PERMISOS_DIR);
  await fs.ensureDir(LIB_CAMPOS_DIR);

  const port = Number(process.env.WEB_PORT || "3009");
  app.listen(port, () => {
    console.log(`✅ WebApp lista: http://localhost:${port}`);
    console.log(`✅ Concurrencia (MAX_CONCURRENT_RUNS): ${MAX_CONCURRENT_RUNS}`);
    console.log(`📌 ROOT: ${ROOT}`);
    console.log(`📌 LIB_PERMISOS_DIR: ${LIB_PERMISOS_DIR}`);
  });
})().catch((e) => {
  console.error("❌ Error iniciando WebApp:", e?.message || e);
  process.exit(1);
});
