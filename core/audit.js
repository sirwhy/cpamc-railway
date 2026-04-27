/**
 * CPAMC Audit Logger v3
 *
 * Persistent audit trail. Mirip `src/security/audit.py` di claude-code-telegram:
 *   - command       — user mengetik /command
 *   - tool_call     — engine mengeksekusi tool (execute_command, write_file, ...)
 *   - webhook       — webhook diterima
 *   - auth          — user dicek dan ditolak/diterima
 *   - error         — error tak terduga
 *   - notification  — pesan dikirim oleh NotificationService
 *
 * Semua entry ditulis ke MongoDB collection `auditlogs`. Jika MongoDB
 * tidak tersedia, log tetap muncul di stdout sehingga audit trail
 * tetap ada meski non-persisten.
 */

const db = require('./db');

function model() {
  if (!db.isReady()) return null;
  return require('./models').AuditLog;
}

class AuditLogger {
  async log(userId, action, detail = {}, options = {}) {
    const {
      platform = 'unknown',
      success = true
    } = options;

    const entry = {
      userId: String(userId || 'system'),
      platform,
      action,
      detail,
      success,
      timestamp: new Date()
    };

    // Stdout fallback supaya selalu ada trace
    const tag = success ? 'AUDIT' : 'AUDIT_FAIL';
    const summary = typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200);
    console.log(`[${tag}] user=${entry.userId} platform=${platform} action=${action} ${summary}`);

    const M = model();
    if (M) {
      try {
        await M.create(entry);
      } catch (e) {
        console.error('AuditLog write failed:', e.message);
      }
    }
  }

  async logCommand(userId, command, args = [], options = {}) {
    return this.log(userId, 'command', { command, args }, options);
  }

  async logToolCall(userId, toolName, args = {}, options = {}) {
    return this.log(userId, 'tool_call', { tool: toolName, args }, options);
  }

  async logWebhook(provider, eventType, deliveryId, options = {}) {
    return this.log('webhook', 'webhook', { provider, eventType, deliveryId }, {
      platform: 'webhook',
      ...options
    });
  }

  async logAuth(userId, allowed, reason = '', options = {}) {
    return this.log(userId, 'auth', { allowed, reason }, {
      success: allowed,
      ...options
    });
  }

  async logError(userId, error, context = '', options = {}) {
    const detail = {
      message: error?.message || String(error),
      context,
      stack: error?.stack?.split('\n').slice(0, 5).join('\n')
    };
    return this.log(userId, 'error', detail, { success: false, ...options });
  }

  async logNotification(chatId, payload, options = {}) {
    return this.log(chatId, 'notification', payload, {
      platform: 'telegram',
      ...options
    });
  }

  /** Get the last N audit entries for a user. */
  async getRecent(userId, limit = 20) {
    const M = model();
    if (!M) return [];
    return M.find({ userId: String(userId) })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
  }

  /** Stats summary for /status command. */
  async stats() {
    const M = model();
    if (!M) return { backend: 'stdout', total: 0 };
    const total = await M.countDocuments();
    const errors = await M.countDocuments({ success: false });
    return { backend: 'mongodb', total, errors };
  }
}

module.exports = new AuditLogger();
