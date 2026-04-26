/**
 * CPAMC Session Exporter v3
 * Export chat sessions in Markdown, JSON, or HTML
 * Inspired by claude-code-telegram session_export feature
 */

class SessionExporter {
  /**
   * Export session history to specified format
   * @param {Array} history - Chat history array
   * @param {string} format - 'markdown' | 'json' | 'html'
   * @param {string} userId - User identifier
   * @returns {{ content: string, filename: string, mimeType: string }}
   */
  export(history, format = 'markdown', userId = 'user') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const cleanHistory = history.filter(
      m => m.role === 'user' || m.role === 'assistant'
    );

    switch (format) {
      case 'json':
        return this._toJSON(cleanHistory, userId, timestamp);
      case 'html':
        return this._toHTML(cleanHistory, userId, timestamp);
      case 'markdown':
      default:
        return this._toMarkdown(cleanHistory, userId, timestamp);
    }
  }

  _toMarkdown(history, userId, timestamp) {
    const lines = [
      `# CPAMC AI Chat Session`,
      `**User:** ${userId}`,
      `**Exported:** ${new Date().toLocaleString('id-ID')}`,
      `**Messages:** ${history.length}`,
      '',
      '---',
      ''
    ];

    for (const msg of history) {
      if (msg.role === 'user') {
        lines.push(`### 👤 User`);
        lines.push(msg.content);
        lines.push('');
      } else if (msg.role === 'assistant') {
        lines.push(`### 🤖 CPAMC AI`);
        lines.push(msg.content);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }

    return {
      content: lines.join('\n'),
      filename: `cpamc-session-${timestamp}.md`,
      mimeType: 'text/markdown'
    };
  }

  _toJSON(history, userId, timestamp) {
    const data = {
      meta: {
        userId,
        exportedAt: new Date().toISOString(),
        messageCount: history.length,
        version: '3.0.0'
      },
      messages: history.map((m, i) => ({
        index: i + 1,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || null
      }))
    };

    return {
      content: JSON.stringify(data, null, 2),
      filename: `cpamc-session-${timestamp}.json`,
      mimeType: 'application/json'
    };
  }

  _toHTML(history, userId, timestamp) {
    const messages = history
      .map(msg => {
        const isUser = msg.role === 'user';
        const label = isUser ? '👤 User' : '🤖 CPAMC AI';
        const cls = isUser ? 'user' : 'ai';
        const content = this._escapeHtml(msg.content).replace(/\n/g, '<br>');
        return `
        <div class="message ${cls}">
          <div class="label">${label}</div>
          <div class="content">${content}</div>
        </div>`;
      })
      .join('\n');

    const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<title>CPAMC Session Export</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; max-width: 800px; margin: 40px auto; padding: 20px; }
  h1 { color: #3b82f6; border-bottom: 1px solid #2e2e2e; padding-bottom: 10px; }
  .meta { color: #888; font-size: 13px; margin-bottom: 20px; }
  .message { margin: 16px 0; padding: 14px; border-radius: 10px; }
  .message.user { background: #1d3557; border-left: 3px solid #3b82f6; }
  .message.ai { background: #1a1a1a; border-left: 3px solid #22c55e; }
  .label { font-size: 12px; font-weight: 600; color: #888; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .5px; }
  .content { line-height: 1.7; white-space: pre-wrap; }
  code { background: #242424; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 13px; }
</style>
</head>
<body>
  <h1>CPAMC AI Chat Session</h1>
  <div class="meta">
    <strong>User:</strong> ${this._escapeHtml(userId)} &nbsp;|&nbsp;
    <strong>Exported:</strong> ${new Date().toLocaleString('id-ID')} &nbsp;|&nbsp;
    <strong>Messages:</strong> ${history.length}
  </div>
  ${messages}
</body>
</html>`;

    return {
      content: html,
      filename: `cpamc-session-${timestamp}.html`,
      mimeType: 'text/html'
    };
  }

  _escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

module.exports = new SessionExporter();
