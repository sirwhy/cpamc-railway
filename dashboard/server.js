/**
 * CPAMC Dashboard Server v3
 * Express server with WebSocket support + full REST API
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');
require('dotenv').config();

const db = require('../core/db');
const engine = require('../core/engine');
const sessionExport = require('../core/session_export');
const modelDetector = require('../core/model_detector');
const audit = require('../core/audit');
const webhook = require('../core/webhook');
const scheduler = require('../core/scheduler');
const notifications = require('../core/notifications');
const projects = require('../core/projects');

// Init MongoDB dulu sebelum terima request
db.connect();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(cors());

// IMPORTANT: webhook endpoints butuh raw body untuk verifikasi HMAC,
// jadi mount mereka SEBELUM express.json().
webhook.mount(app, { engine });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/workspace', express.static(path.join(__dirname, '..', 'workspace')));

// ── REST API ────────────────────────────────────────────────────

// Model list endpoint
app.get('/api/models', async (req, res) => {
  const refresh = req.query.refresh === '1';
  const models = await modelDetector.getAllModels(refresh);
  const info   = modelDetector.getInfo();
  res.json({ models, selected: info.selected, total: models.length, source: info.source, lastFetch: info.lastFetch });
});

// Switch model at runtime
app.post('/api/models/select', async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'model required' });
  modelDetector.setModel(model);
  res.json({ ok: true, model });
});

app.get('/api/status', async (req, res) => {
  try {
    const stats = await engine.getStats();
    res.json({ ok: true, version: '3.0.0', stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { userId = 'web-user', message, platform = 'web', imageBase64, imageType } = req.body;
    if (!message) return res.status(400).json({ error: 'message wajib diisi' });

    const result = await engine.chat(userId, message, {
      platform,
      imageBase64,
      imageType
    });
    res.json(result);
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Skills API
app.get('/api/skills', async (req, res) => {
  res.json(await engine.skills.list());
});

app.post('/api/skills', async (req, res) => {
  try {
    await engine.skills.install(req.body);
    res.json({ ok: true, message: `Skill "${req.body.name}" berhasil diinstall` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/skills/:name', async (req, res) => {
  await engine.skills.uninstall(decodeURIComponent(req.params.name));
  res.json({ ok: true });
});

// Memory API
app.get('/api/memory/:userId', async (req, res) => {
  res.json(await engine.memory.getAll(req.params.userId));
});

app.post('/api/memory/:userId', async (req, res) => {
  const id = await engine.memory.save(req.params.userId, req.body.content, 'manual');
  res.json({ ok: true, id });
});

app.delete('/api/memory/:userId', async (req, res) => {
  await engine.memory.deleteAll(req.params.userId);
  res.json({ ok: true });
});

app.delete('/api/memory/:userId/:id', async (req, res) => {
  await engine.memory.delete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/memory/:userId/search/:query', async (req, res) => {
  const results = await engine.memory.search(req.params.userId, req.params.query);
  res.json(results);
});

// Session API
app.get('/api/session/:userId', async (req, res) => {
  const session = await engine.loadSession(req.params.userId);
  res.json({
    userId:       session.userId,
    platform:     session.platform,
    messageCount: session.messageCount,
    activeSkills: session.activeSkills,
    historyLength: session.history.length,
    createdAt:    session.createdAt,
    lastActive:   session.lastActive
  });
});

app.delete('/api/session/:userId', (req, res) => {
  engine.clearSession(req.params.userId);
  res.json({ ok: true });
});

// Stop running tool loop for a session
app.post('/api/session/:userId/stop', (req, res) => {
  engine.requestCancel(req.params.userId);
  res.json({ ok: true });
});

// ── Audit log API ──────────────────────────────────────────────
app.get('/api/audit/:userId', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const entries = await audit.getRecent(req.params.userId, limit);
  res.json(entries);
});

app.get('/api/audit/stats', async (req, res) => {
  res.json(await audit.stats());
});

// ── Projects (workspace registry) API ──────────────────────────
app.get('/api/projects', async (req, res) => {
  res.json(await projects.list());
});

app.post('/api/projects', async (req, res) => {
  try {
    await projects.register(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/projects/:name', async (req, res) => {
  await projects.unregister(decodeURIComponent(req.params.name));
  res.json({ ok: true });
});

// ── Scheduled Jobs API ─────────────────────────────────────────
app.get('/api/jobs', async (req, res) => {
  res.json(await scheduler.listJobs());
});

app.post('/api/jobs', async (req, res) => {
  try {
    const jobId = await scheduler.addJob(req.body);
    res.json({ ok: true, jobId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/jobs/:jobId', async (req, res) => {
  await scheduler.removeJob(req.params.jobId);
  res.json({ ok: true });
});

app.post('/api/jobs/:jobId/toggle', async (req, res) => {
  const enabled = req.body.enabled !== false;
  await scheduler.toggleJob(req.params.jobId, enabled);
  res.json({ ok: true });
});

// ── Notifications API (proactive broadcast) ────────────────────
app.post('/api/notify', async (req, res) => {
  const { chatId, text } = req.body;
  if (!text) return res.status(400).json({ error: 'text wajib diisi' });
  if (chatId) {
    await notifications.send(chatId, text);
  } else {
    await notifications.broadcast(text);
  }
  res.json({ ok: true });
});

// Session Export API
app.get('/api/session/:userId/export', async (req, res) => {
  const format  = req.query.format || 'markdown';
  const session = await engine.loadSession(req.params.userId);

  if (!session.history.length) {
    return res.status(404).json({ error: 'No history to export' });
  }

  const exported = sessionExport.export(session.history, format, req.params.userId);
  res.setHeader('Content-Type', exported.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
  res.send(exported.content);
});

// ── WebSocket for live chat ─────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === 'chat') {
        const { userId = 'ws-user', message } = data;

        ws.send(JSON.stringify({ type: 'status', text: '⌛ Memproses...' }));

        const result = await engine.chat(userId, message, {
          platform: 'web',
          onStatus: (msg) => {
            ws.send(JSON.stringify({ type: 'status', text: msg }));
          }
        });

        ws.send(JSON.stringify({
          type: 'response',
          text: result.text,
          model: result.model,
          skills: result.skills
        }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', text: e.message }));
    }
  });

  ws.on('error', (e) => console.error('WS error:', e.message));
});

// ── Start Telegram Bot ──────────────────────────────────────────

if (process.env.TELEGRAM_BOT_TOKEN) {
  try {
    require('../bot/telegram');
    console.log('✅ Telegram Bot dimulai');
  } catch (e) {
    console.error('❌ Telegram Bot gagal:', e.message);
  }
} else if (process.env.ENABLE_SCHEDULER === 'true') {
  // Tanpa bot tetap bisa jalanin scheduler buat job non-Telegram
  scheduler.init({ engine, notifications });
  scheduler.start().catch(e => console.error('Scheduler start error:', e.message));
}

// ── Start Server ───────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ CPAMC AI Server v3 jalan di port ${PORT}`);
  console.log(`   Dashboard : http://localhost:${PORT}`);
  const apiUrl = process.env.CPAMC_BASE_URL || '(tidak diset)';
  const upstream = require('../core/model_detector');
  console.log(`   API       : ${apiUrl}${upstream.is9Router() ? ' (9router)' : ''}`);
  try {
    const active = await upstream.getActiveModel(true);
    const info   = upstream.getInfo();
    console.log(`   Model     : ${active}${info.isManual ? ' (env)' : ` (auto, dari ${info.total} model)`}`);
  } catch {
    console.log(`   Model     : ${process.env.MODEL || 'claude-sonnet-4-5'} (fallback)`);
  }
  console.log(`   WebSocket : ws://localhost:${PORT}`);
});

module.exports = app;
