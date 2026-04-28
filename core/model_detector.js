/**
 * CPAMC Model Detector v3
 * Auto-detect semua model yang tersedia dari upstream OpenAI-compatible
 * `/v1/models` endpoint.
 *
 * Compatible dengan:
 *   - 9router (lokal, http://localhost:20128/v1) — model ID format `<alias>/<id>`
 *     contoh: `openai/gpt-4o`, `anthropic/claude-sonnet-4-5`, `or/glm-4.5`
 *   - Cloud proxy CPAMC (cli-proxy-api Railway) — model ID format bare
 *     contoh: `claude-sonnet-4-5`, `gpt-4o`
 *   - OpenRouter, OpenAI langsung, dll. (selama exposes /v1/models)
 *
 * Strategi pemilihan model:
 *  1. Jika MODEL diset di env → pakai itu (override manual; bisa prefixed atau bare)
 *  2. Ambil daftar model dari /v1/models
 *  3. Pilih model terbaik via priority list (prefix-aware matching)
 *  4. Refresh setiap 10 menit
 */

const fetch = require('node-fetch');
require('dotenv').config();

const CPAMC_URL = process.env.CPAMC_BASE_URL || 'https://cli-proxy-api-production-9440.up.railway.app/v1';
const CPAMC_KEY = process.env.CPAMC_API_KEY  || 'dummy';

/**
 * Detect 9router dari URL — supaya log lebih informatif
 */
function is9Router(url = CPAMC_URL) {
  return /(:20128|9router)/i.test(url);
}

// Priority list — model dengan rank lebih tinggi lebih diutamakan
// Urutan: paling powerful → paling ringan
const MODEL_PRIORITY = [
  // Claude terbaru & terkuat
  'claude-opus-4',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-5-sonnet',
  'claude-3-opus-20240229',
  'claude-3-opus',
  // GPT tier
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-4o-mini',
  'gpt-3.5-turbo',
  // Gemini
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-pro',
  // Mistral / lainnya
  'mistral-large',
  'mistral-medium',
  'mistral-small',
  'llama-3.1-70b',
  'llama-3.1-8b',
];

let cachedModels   = [];
let selectedModel  = process.env.MODEL || null; // null = auto-detect
let lastFetch      = 0;
const CACHE_TTL    = 10 * 60 * 1000; // 10 menit

/**
 * Fetch semua model dari API
 */
async function fetchModels() {
  try {
    const res = await fetch(`${CPAMC_URL}/models`, {
      headers: { Authorization: `Bearer ${CPAMC_KEY}` },
      timeout: 8000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Support format: { data: [...] } atau langsung array
    const list = Array.isArray(data) ? data : (data.data || []);
    cachedModels = list.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
    lastFetch    = Date.now();
    return cachedModels;
  } catch (e) {
    console.warn(`⚠️  Gagal fetch model list: ${e.message}`);
    return cachedModels; // return cache lama jika ada
  }
}

/**
 * Strip provider prefix dari model ID 9router
 *   `openai/gpt-4o`             -> `gpt-4o`
 *   `anthropic/claude-sonnet-4-5` -> `claude-sonnet-4-5`
 *   `or/glm-4.5`                  -> `glm-4.5`
 *   `gpt-4o`                      -> `gpt-4o` (no-op untuk bare ID)
 *   `combo-name`                  -> `combo-name`
 */
function baseModelId(id) {
  if (typeof id !== 'string') return '';
  // Ambil segmen terakhir setelah '/'
  const parts = id.split('/');
  return parts[parts.length - 1];
}

/**
 * Pilih model terbaik dari daftar yang tersedia.
 * Prefix-aware: support format `<provider>/<model>` (9router) maupun bare (`gpt-4o`).
 */
function pickBestModel(available) {
  if (!available.length) return null;

  const lc = available.map(m => ({ raw: m, base: baseModelId(m).toLowerCase(), full: m.toLowerCase() }));

  // 1) exact match pada full ID (`anthropic/claude-sonnet-4-5` === preferred)
  // 2) match base ID setelah strip prefix (preferred `claude-sonnet-4-5` matches `anthropic/claude-sonnet-4-5`)
  for (const preferred of MODEL_PRIORITY) {
    const p = preferred.toLowerCase();
    const exact = lc.find(m => m.full === p);
    if (exact) return exact.raw;
    const baseHit = lc.find(m => m.base === p);
    if (baseHit) return baseHit.raw;
  }

  // 3) Keyword fallback (claude > gpt-4 > gemini > mistral)
  const keywords = ['claude', 'gpt-4', 'gemini', 'mistral'];
  for (const kw of keywords) {
    const found = lc.find(m => m.base.includes(kw) || m.full.includes(kw));
    if (found) return found.raw;
  }

  // 4) Fallback terakhir: ambil model pertama
  return available[0];
}

/**
 * Dapatkan model yang aktif saat ini
 * Auto-refresh jika cache sudah expired
 */
async function getActiveModel(forceRefresh = false) {
  // Manual override via env
  if (process.env.MODEL) return process.env.MODEL;

  const now = Date.now();
  if (forceRefresh || now - lastFetch > CACHE_TTL || cachedModels.length === 0) {
    await fetchModels();
    selectedModel = pickBestModel(cachedModels);
    if (selectedModel) {
      console.log(`🤖 Model dipilih otomatis: ${selectedModel} (dari ${cachedModels.length} model tersedia)`);
    }
  }

  // Hardcoded fallback bila /v1/models tidak bisa diakses sama sekali
  return selectedModel || 'claude-sonnet-4-5';
}

/**
 * Dapatkan semua model yang tersedia (untuk dashboard)
 */
async function getAllModels(forceRefresh = false) {
  const now = Date.now();
  if (forceRefresh || now - lastFetch > CACHE_TTL || cachedModels.length === 0) {
    await fetchModels();
  }
  return cachedModels;
}

/**
 * Set model secara manual (runtime override, tanpa env)
 */
function setModel(modelId) {
  selectedModel = modelId;
  console.log(`🤖 Model diubah ke: ${modelId}`);
}

/**
 * Info lengkap
 */
function getInfo() {
  return {
    selected:    selectedModel,
    available:   cachedModels,
    total:       cachedModels.length,
    lastFetch:   lastFetch ? new Date(lastFetch).toISOString() : null,
    isManual:    !!process.env.MODEL,
    source:      process.env.MODEL ? 'env' : 'auto-detect',
    upstream:    CPAMC_URL,
    is9Router:   is9Router()
  };
}

// Init saat module dimuat
getActiveModel().catch(() => {});

// Auto-refresh setiap 10 menit
setInterval(() => {
  getActiveModel(true).catch(() => {});
}, CACHE_TTL);

module.exports = { getActiveModel, getAllModels, setModel, getInfo, fetchModels, baseModelId, is9Router, pickBestModel };
