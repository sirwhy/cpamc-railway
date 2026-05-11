/**
 * Hermes Worker Client v1
 *
 * Bridge antara CPAMC bot (Node.js / Railway / CPU-only) dan Hermes Worker
 * (Python FastAPI / GPU VPS). Worker melakukan pekerjaan berat:
 *  - yt-dlp download
 *  - Demucs source separation
 *  - Whisper transcription
 *  - LLM translation (syllable-aware)
 *  - basic-pitch MIDI extraction
 *  - XTTS-v2 multilingual synthesis
 *  - RVC v2 voice timbre conversion
 *  - ffmpeg mix + master
 *
 * Bot tinggal panggil tools `hermes_*` yang dibungkus di `core/tools.js`.
 *
 * ENV vars:
 *  - HERMES_WORKER_URL    (mis. https://hermes.example.com)
 *  - HERMES_WORKER_TOKEN  (Bearer token, harus match worker .env)
 *  - HERMES_TIMEOUT_MS    (opsional, default 30000 untuk request kontrol;
 *                          poll status dibatasi 10 menit dari sisi LLM)
 */

const fetch = require('node-fetch');

const WORKER_URL = (process.env.HERMES_WORKER_URL || '').replace(/\/+$/, '');
const WORKER_TOKEN = process.env.HERMES_WORKER_TOKEN || '';
const TIMEOUT_MS = parseInt(process.env.HERMES_TIMEOUT_MS || '30000');

function isConfigured() {
  return !!(WORKER_URL && WORKER_TOKEN);
}

function configError() {
  return (
    'Hermes worker belum dikonfigurasi.\n' +
    'Admin perlu set di Railway env:\n' +
    '  HERMES_WORKER_URL   = https://<vps-domain>\n' +
    '  HERMES_WORKER_TOKEN = <bearer token yang sama dengan worker .env>\n' +
    'Lihat docs/hermes-deployment.md untuk setup AWS VPS GPU.'
  );
}

async function call(method, pathSegment, { body, query, timeoutMs } = {}) {
  if (!isConfigured()) {
    const e = new Error(configError());
    e.code = 'NOT_CONFIGURED';
    throw e;
  }

  const url = new URL(WORKER_URL + pathSegment);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${WORKER_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { _raw: text }; }
    if (!res.ok) {
      const msg = (data && (data.detail || data.error || data.message)) || res.statusText;
      const e = new Error(`Worker ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      e.status = res.status;
      e.body = data;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function healthz() {
  return call('GET', '/healthz', { timeoutMs: 5000 });
}

async function listVoices() {
  return call('GET', '/v1/voices');
}

async function createCover(payload) {
  return call('POST', '/v1/cover', { body: payload });
}

async function getJobStatus(jobId) {
  return call('GET', `/v1/jobs/${encodeURIComponent(jobId)}/status`);
}

async function listJobs({ userId, limit = 10 } = {}) {
  return call('GET', '/v1/jobs', { query: { user_id: userId, limit } });
}

async function cancelJob(jobId) {
  return call('POST', `/v1/jobs/${encodeURIComponent(jobId)}/cancel`);
}

async function uploadVoice(payload) {
  return call('POST', '/v1/voices', { body: payload });
}

/**
 * Build absolute URL for an artifact (mp3, stems zip, lyrics srt, midi).
 * Worker returns artifact filenames in /v1/jobs/{id}/status; bot uses this
 * helper to construct full URL when downloading/streaming to Telegram.
 */
function artifactUrl(jobId, filename) {
  if (!isConfigured()) return null;
  return `${WORKER_URL}/v1/jobs/${encodeURIComponent(jobId)}/result/${encodeURIComponent(filename)}`;
}

/**
 * Fetch an artifact as a Buffer (used by bot to upload to Telegram).
 * Returns { buffer, contentType, filename }.
 */
async function fetchArtifact(jobId, filename) {
  if (!isConfigured()) throw new Error(configError());
  const url = artifactUrl(jobId, filename);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${WORKER_TOKEN}` }
  });
  if (!res.ok) {
    throw new Error(`Worker artifact ${res.status}: ${res.statusText} (${filename})`);
  }
  const buffer = await res.buffer();
  return {
    buffer,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    filename
  };
}

module.exports = {
  isConfigured,
  configError,
  healthz,
  listVoices,
  createCover,
  getJobStatus,
  listJobs,
  cancelJob,
  uploadVoice,
  artifactUrl,
  fetchArtifact,
  WORKER_URL,
  TIMEOUT_MS
};
