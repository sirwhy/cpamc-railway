/**
 * CPAMC Model Detector v3
 * Auto-detect semua model yang tersedia dari 9router (OpenAI-compatible /v1/models)
 * Tidak perlu setting MODEL di environment variables.
 *
 * Strategi pemilihan model:
 *  1. Jika MODEL diset di env → pakai itu (override manual)
 *  2. Ambil daftar model dari /v1/models
 *  3. Pilih model terbaik berdasarkan priority list
 *  4. Refresh setiap 10 menit
 */

const fetch = require('node-fetch');
require('dotenv').config();

const CPAMC_URL = process.env.CPAMC_BASE_URL || 'https://cli-proxy-api-production-9440.up.railway.app/v1';
const CPAMC_KEY = process.env.CPAMC_API_KEY  || 'dummy';

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
 * Pilih model terbaik dari daftar yang tersedia
 */
function pickBestModel(available) {
  if (!available.length) return null;

  // Cari di priority list
  for (const preferred of MODEL_PRIORITY) {
    const found = available.find(m => m.toLowerCase() === preferred.toLowerCase());
    if (found) return found;
  }

  // Fallback: cari yang mengandung kata kunci bagus
  const keywords = ['claude', 'gpt-4', 'gemini', 'mistral'];
  for (const kw of keywords) {
    const found = available.find(m => m.toLowerCase().includes(kw));
    if (found) return found;
  }

  // Fallback terakhir: ambil model pertama
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

  return selectedModel || 'claude-sonnet-4-5'; // hardcoded fallback
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
    selected:   selectedModel,
    available:  cachedModels,
    total:      cachedModels.length,
    lastFetch:  lastFetch ? new Date(lastFetch).toISOString() : null,
    isManual:   !!process.env.MODEL,
    source:     process.env.MODEL ? 'env' : 'auto-detect'
  };
}

// Init saat module dimuat
getActiveModel().catch(() => {});

// Auto-refresh setiap 10 menit
setInterval(() => {
  getActiveModel(true).catch(() => {});
}, CACHE_TTL);

module.exports = { getActiveModel, getAllModels, setModel, getInfo, fetchModels };
