/**
 * CPAMC Webhook Handler v3
 *
 * Setara `src/api/server.py` + `src/api/auth.py` di claude-code-telegram.
 * Menerima webhook dari provider eksternal (GitHub default, atau generic
 * via Bearer token) dan memicu engine untuk merespons.
 *
 * Endpoint:
 *   POST /webhooks/github      — verifikasi HMAC-SHA256
 *   POST /webhooks/:provider   — verifikasi Bearer token (WEBHOOK_API_SECRET)
 *
 * Fitur:
 *   - Verifikasi signature (timing-safe)
 *   - Atomic dedup via collection WebhookEvent (compound unique index)
 *   - Trigger engine.chat() untuk men-generate respons AI
 *   - Broadcast hasil via NotificationService
 *
 * Variabel env:
 *   GITHUB_WEBHOOK_SECRET   — secret HMAC GitHub
 *   WEBHOOK_API_SECRET      — bearer token generik (provider non-GitHub)
 *   WEBHOOK_TRIGGER_AI      — set "true" untuk auto-respons via engine
 *   NOTIFICATION_CHAT_IDS   — chat ID Telegram default untuk broadcast
 */

const crypto = require('crypto');
const db = require('./db');
const audit = require('./audit');
const notifications = require('./notifications');

function model() {
  if (!db.isReady()) return null;
  return require('./models').WebhookEvent;
}

function verifyGithubSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected = 'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expected)
    );
  } catch (e) {
    return false;
  }
}

function verifyBearer(authHeader, secret) {
  if (!authHeader || !secret) return false;
  const expected = `Bearer ${secret}`;
  if (authHeader.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

/**
 * Try to record a webhook delivery atomically.
 * Returns true if it's the first time we see this delivery_id, false if dup.
 */
async function recordWebhook({ provider, eventType, deliveryId, payload }) {
  const M = model();
  if (!M) return true; // tanpa DB tidak bisa dedup → terima saja
  try {
    await M.create({ provider, eventType, deliveryId, payload, processed: false });
    return true;
  } catch (e) {
    if (e.code === 11000) return false; // duplicate key
    throw e;
  }
}

async function markProcessed(provider, deliveryId) {
  const M = model();
  if (!M) return;
  await M.updateOne({ provider, deliveryId }, { $set: { processed: true } }).catch(() => {});
}

/**
 * Build a human-readable summary of a webhook payload.
 * Sederhana — bisa diperluas per provider.
 */
function summarizeWebhook(provider, eventType, payload) {
  if (provider === 'github') {
    if (eventType === 'push') {
      const repo = payload?.repository?.full_name || 'unknown';
      const branch = (payload?.ref || '').replace('refs/heads/', '');
      const commits = (payload?.commits || []).map(c => `• ${c.message?.split('\n')[0]} (${c.author?.name})`).join('\n');
      return `📦 *Push ke ${repo}* (${branch})\n${commits || '(no commits)'}`;
    }
    if (eventType === 'pull_request') {
      const action = payload?.action;
      const pr = payload?.pull_request;
      return `🔀 *PR ${action}*: #${pr?.number} ${pr?.title}\n${pr?.html_url}`;
    }
    if (eventType === 'issues') {
      const issue = payload?.issue;
      return `🐛 *Issue ${payload?.action}*: #${issue?.number} ${issue?.title}\n${issue?.html_url}`;
    }
    if (eventType === 'workflow_run') {
      const wf = payload?.workflow_run;
      return `⚙️ *Workflow ${wf?.status}/${wf?.conclusion}*: ${wf?.name}\n${wf?.html_url}`;
    }
  }
  return `🔔 *Webhook ${provider}/${eventType}* received.`;
}

/**
 * Mount webhook routes onto an Express app.
 * Use express.raw() so we can verify HMAC signatures.
 */
function mount(app, { engine } = {}) {
  const express = require('express');

  // GitHub-specific endpoint with HMAC verification
  app.post('/webhooks/github',
    express.raw({ type: '*/*', limit: '5mb' }),
    async (req, res) => {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      if (!secret) {
        return res.status(500).json({ error: 'GITHUB_WEBHOOK_SECRET not configured' });
      }
      const rawBody = req.body; // Buffer karena express.raw
      const sig = req.headers['x-hub-signature-256'];
      if (!verifyGithubSignature(rawBody, sig, secret)) {
        await audit.log('webhook', 'auth', { provider: 'github', allowed: false, reason: 'bad signature' }, { success: false });
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const eventType = req.headers['x-github-event'] || 'unknown';
      const deliveryId = req.headers['x-github-delivery'] || `gh_${Date.now()}`;

      let payload = {};
      try { payload = JSON.parse(rawBody.toString('utf8')); } catch (e) {
        payload = { raw: rawBody.toString('utf8').slice(0, 5000) };
      }

      const isNew = await recordWebhook({ provider: 'github', eventType, deliveryId, payload });
      await audit.logWebhook('github', eventType, deliveryId, { success: true, platform: 'webhook' });

      if (!isNew) {
        return res.json({ status: 'duplicate', deliveryId });
      }

      const summary = summarizeWebhook('github', eventType, payload);
      const broadcastEnabled = (process.env.WEBHOOK_BROADCAST !== 'false');
      if (broadcastEnabled) {
        await notifications.broadcast(summary);
      }

      // Trigger AI follow-up if enabled
      if (engine && process.env.WEBHOOK_TRIGGER_AI === 'true') {
        engine.chat(`webhook:github:${deliveryId}`, summary, { platform: 'webhook' })
          .then(r => notifications.broadcast(`🤖 *AI:* ${r.text}`))
          .catch(e => audit.logError(deliveryId, e, 'webhook.ai_trigger'));
      }

      await markProcessed('github', deliveryId);
      res.json({ status: 'ok', deliveryId });
    }
  );

  // Generic provider endpoint with Bearer auth
  app.post('/webhooks/:provider',
    express.raw({ type: '*/*', limit: '5mb' }),
    async (req, res) => {
      const provider = req.params.provider;
      if (provider === 'github') return res.status(404).json({ error: 'use /webhooks/github' });

      const secret = process.env.WEBHOOK_API_SECRET;
      if (!secret) {
        return res.status(500).json({ error: 'WEBHOOK_API_SECRET not configured' });
      }
      if (!verifyBearer(req.headers.authorization, secret)) {
        await audit.log('webhook', 'auth', { provider, allowed: false }, { success: false });
        return res.status(401).json({ error: 'Invalid authorization' });
      }

      const rawBody = req.body;
      let payload = {};
      try { payload = JSON.parse(rawBody.toString('utf8')); } catch (e) {
        payload = { raw: rawBody.toString('utf8').slice(0, 5000) };
      }
      const eventType = req.headers['x-event-type'] || 'unknown';
      const deliveryId = req.headers['x-delivery-id'] || `gen_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

      const isNew = await recordWebhook({ provider, eventType, deliveryId, payload });
      await audit.logWebhook(provider, eventType, deliveryId, { success: true });

      if (!isNew) return res.json({ status: 'duplicate', deliveryId });

      const summary = `🔔 *Webhook ${provider}/${eventType}*\n${JSON.stringify(payload).slice(0, 1500)}`;
      if (process.env.WEBHOOK_BROADCAST !== 'false') {
        await notifications.broadcast(summary);
      }

      if (engine && process.env.WEBHOOK_TRIGGER_AI === 'true') {
        engine.chat(`webhook:${provider}:${deliveryId}`, summary, { platform: 'webhook' })
          .then(r => notifications.broadcast(`🤖 *AI:* ${r.text}`))
          .catch(e => audit.logError(deliveryId, e, 'webhook.ai_trigger'));
      }

      await markProcessed(provider, deliveryId);
      res.json({ status: 'ok', deliveryId });
    }
  );

  // List recent webhook events for the dashboard
  app.get('/api/webhooks/recent', async (req, res) => {
    const M = model();
    if (!M) return res.json([]);
    const limit = Math.min(parseInt(req.query.limit) || 30, 200);
    const items = await M.find().sort({ receivedAt: -1 }).limit(limit).lean();
    res.json(items.map(i => ({
      provider: i.provider,
      eventType: i.eventType,
      deliveryId: i.deliveryId,
      processed: i.processed,
      receivedAt: i.receivedAt
    })));
  });
}

module.exports = {
  mount,
  verifyGithubSignature,
  verifyBearer,
  recordWebhook,
  summarizeWebhook
};
