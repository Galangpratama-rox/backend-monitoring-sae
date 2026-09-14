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

// VIP store: { [vipLevel]: { label, color, members: [{ userId, username, addedAt }] } }
const vipStore = new Map(); // vipLevel (number) -> { label, color, members[] }

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
  for (const [userId, data] of playerStore) {
    players.push({
      ...data,
      online: now - data._receivedAt < OFFLINE_MS,
      vipLevel: vipMap.get(userId) || 0,
    });
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

// ── VIP store ─────────────────────────────────────────────────────────────────
// vipMap: userId -> vipLevel (number, 0 = no VIP)
// vipGroups: vipLevel -> { label, color }
const vipMap    = new Map(); // userId -> vipLevel
const vipGroups = new Map(); // vipLevel -> { label, color }

// Default VIP group colors
const VIP_COLORS = ['#f59e0b','#a78bfa','#22c55e','#60a5fa','#ec4899','#fb923c','#34d399','#f472b6'];
function vipColor(level) {
  return VIP_COLORS[(level - 1) % VIP_COLORS.length] || '#f59e0b';
}

// ── GET /api/vip ──────────────────────────────────────────────────────────────
// Returns all VIP groups + members
app.get("/api/vip", (req, res) => {
  const groups = {};
  for (const [level, info] of vipGroups) {
    groups[level] = { ...info, members: [] };
  }
  for (const [userId, level] of vipMap) {
    if (!groups[level]) {
      groups[level] = { label: `VIP ${level}`, color: vipColor(level), members: [] };
    }
    const player = playerStore.get(userId);
    groups[level].members.push({
      userId,
      username: player?.username || String(userId),
      addedAt: vipMap._addedAt?.get(userId) || null,
    });
  }
  return res.json({ groups });
});

// ── POST /api/vip/assign ──────────────────────────────────────────────────────
// Body: { userId, vipLevel, label? }
// Requires X-Monitor-Key header
app.post("/api/vip/assign", (req, res) => {
  const key = req.headers["x-monitor-key"];
  if (key !== MONITOR_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { userId, vipLevel, label } = req.body;
  if (!userId || vipLevel === undefined) {
    return res.status(400).json({ error: "userId and vipLevel required" });
  }

  const level = Number(vipLevel);
  if (level === 0) {
    // Remove from VIP
    vipMap.delete(userId);
    return res.json({ ok: true, action: "removed" });
  }

  vipMap.set(userId, level);
  if (!vipGroups.has(level)) {
    vipGroups.set(level, {
      label: label || `VIP ${level}`,
      color: vipColor(level),
    });
  } else if (label) {
    vipGroups.get(level).label = label;
  }
  return res.json({ ok: true, action: "assigned", level });
});

// ── DELETE /api/vip/group/:level ──────────────────────────────────────────────
// Remove entire VIP group
app.delete("/api/vip/group/:level", (req, res) => {
  const key = req.headers["x-monitor-key"];
  if (key !== MONITOR_KEY) return res.status(401).json({ error: "Unauthorized" });

  const level = Number(req.params.level);
  vipGroups.delete(level);
  for (const [uid, lv] of vipMap) {
    if (lv === level) vipMap.delete(uid);
  }
  return res.json({ ok: true });
});

// ── PATCH /api/vip/group/:level ───────────────────────────────────────────────
// Rename a VIP group label or change color
app.patch("/api/vip/group/:level", (req, res) => {
  const key = req.headers["x-monitor-key"];
  if (key !== MONITOR_KEY) return res.status(401).json({ error: "Unauthorized" });

  const level = Number(req.params.level);
  const { label, color } = req.body;
  if (!vipGroups.has(level)) {
    vipGroups.set(level, { label: label || `VIP ${level}`, color: color || vipColor(level) });
  } else {
    const g = vipGroups.get(level);
    if (label) g.label = label;
    if (color) g.color = color;
  }
  return res.json({ ok: true });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SagaHub Monitor API running on port ${PORT}`);
});
