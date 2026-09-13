const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const MONITOR_KEY = process.env.MONITOR_KEY || "sagahub-secret-key";

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow any origin (frontend is hosted separately)
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ limit: "10mb", type: "text/plain" }));

// ── In-memory store ───────────────────────────────────────────────────────────
const playerStore  = new Map(); // userId -> { ...payload, _receivedAt }
let   eggsToday    = 0;
let   eggsTodayDate = new Date().toDateString();
const eggsPrevious = new Map(); // userId -> last known eggs

function refreshDailyEggs() {
  const today = new Date().toDateString();
  if (today !== eggsTodayDate) {
    eggsToday      = 0;
    eggsTodayDate  = today;
    eggsPrevious.clear();
  }
}

// ── POST /api/monitor ─────────────────────────────────────────────────────────
app.post("/api/monitor", (req, res) => {
  const key = req.headers["x-monitor-key"];
  if (key !== MONITOR_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body;
  if (!body || typeof body.userId === "undefined") {
    return res.status(400).json({ error: "Missing userId in payload" });
  }

  refreshDailyEggs();

  const userId   = body.userId;
  const prevEggs = eggsPrevious.get(userId) || 0;
  const currEggs = typeof body.eggs === "number" ? body.eggs : 0;

  if (currEggs > prevEggs) eggsToday += currEggs - prevEggs;
  eggsPrevious.set(userId, currEggs);

  playerStore.set(userId, { ...body, _receivedAt: Date.now() });

  return res.status(200).json({ ok: true });
});

// ── GET /api/stats ────────────────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  refreshDailyEggs();
  const now        = Date.now();
  const OFFLINE_MS = 2 * 60 * 1000;

  const players = [];
  for (const [, data] of playerStore) {
    players.push({ ...data, online: now - data._receivedAt < OFFLINE_MS });
  }

  return res.json({
    onlineCount: players.filter((p) => p.online).length,
    eggsToday,
    players,
  });
});

// ── GET /api/stats/:userId ────────────────────────────────────────────────────
app.get("/api/stats/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  const data   = playerStore.get(userId);
  if (!data) return res.status(404).json({ error: "Player not found" });

  return res.json({
    ...data,
    online: Date.now() - data._receivedAt < 2 * 60 * 1000,
  });
});

// ── POST /api/runtime ─────────────────────────────────────────────────────────
// Receive runtime Lua script from in-game capture
app.post("/api/runtime", (req, res) => {
  const key = req.headers["x-monitor-key"];
  if (key !== MONITOR_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const chunkName = req.headers["x-chunk-name"] || "runtime";
  const size = req.headers["x-size"] || "?";
  const body = req.body;

  if (!body || typeof body !== "string" || body.length < 1000) {
    return res.status(400).json({ error: "Body too small or missing" });
  }

  // Save to disk
  const fs = require("fs");
  const path = require("path");
  const fname = path.join(__dirname, `runtime_${Date.now()}.lua`);
  fs.writeFileSync(fname, body, "utf8");

  console.log(`[RUNTIME] Received: ${body.length} bytes | chunk: ${chunkName} | saved: ${fname}`);
  return res.status(200).json({ ok: true, size: body.length, saved: fname });
});

// ── GET /api/runtime/download ─────────────────────────────────────────────────
// Download the latest saved runtime
app.get("/api/runtime/download", (req, res) => {
  const key = req.query.key;
  if (key !== MONITOR_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const fs = require("fs");
  const path = require("path");
  const files = fs.readdirSync(__dirname)
    .filter(f => f.startsWith("runtime_") && f.endsWith(".lua"))
    .sort()
    .reverse();

  if (files.length === 0) {
    return res.status(404).json({ error: "No runtime file saved yet" });
  }

  const latest = path.join(__dirname, files[0]);
  const content = fs.readFileSync(latest, "utf8");
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Content-Disposition", `attachment; filename="${files[0]}"`);
  return res.send(content);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SagaHub Monitor API running on port ${PORT}`);
});
