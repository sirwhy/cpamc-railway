# CPAMC AI Framework v3

Bot AI berbasis Claude yang powerful, di-deploy di Railway. Versi 3 ini adalah **recode lengkap** dengan semua fitur unggulan dari [claude-code-telegram](https://github.com/claude-code-telegram).

## ✨ Fitur Baru di v3

| Fitur | v2 | v3 |
|-------|----|----|
| Agentic loop (tool use) | ✅ | ✅ Enhanced |
| Skills system | ✅ | ✅ + auto-detect |
| Memory persisten | ✅ | ✅ + search |
| Telegram bot | ✅ | ✅ Enhanced |
| Web dashboard | ✅ | ✅ Enhanced |
| **Voice message (Whisper)** | ❌ | ✅ |
| **Analisis gambar/foto** | ❌ | ✅ |
| **Upload & analisis file** | ❌ | ✅ |
| **Git integration tools** | ❌ | ✅ |
| **Rate limiting per user** | ❌ | ✅ |
| **Session export (MD/JSON/HTML)** | ❌ | ✅ |
| **Quick action buttons** | ❌ | ✅ |
| **Draft streaming** | ❌ | ✅ |
| **User whitelist** | ❌ | ✅ |
| **Memory search** | ❌ | ✅ |
| **WebSocket support** | ❌ | ✅ |
| **Paste image** | ❌ | ✅ |

## 🍃 Setup MongoDB Atlas + Railway (GitHub Student)

Panduan lengkap step-by-step ada di **[docs/RAILWAY_MONGODB_SETUP.md](docs/RAILWAY_MONGODB_SETUP.md)** — dari aktivasi GitHub Student Pack, buat cluster Atlas, whitelist IP Railway, set connection string, sampai verifikasi koneksi & troubleshooting.

**TL;DR:**

1. Aktivasi [GitHub Student Developer Pack](https://education.github.com/pack) → ambil benefit **MongoDB Atlas**.
2. Buat cluster M0 Free di Atlas (region Singapore untuk Indonesia).
3. Buat database user (`cpamc`) + whitelist `0.0.0.0/0` (Railway IP outbound dinamis).
4. Copy connection string, contoh:
   ```
   mongodb+srv://cpamc:PASSWORDMU@cluster.abcde.mongodb.net/cpamc?retryWrites=true&w=majority
   ```
5. Set di Railway → Settings → Variables: `MONGODB_URI=...`.
6. Redeploy. Cek log harus muncul `✅ MongoDB terhubung`.

### ✅ Yang Disimpan di MongoDB
| Collection | Isi | Persisten? |
|------------|------|-----------|
| `memories` | Fakta/preferensi user (manual + auto-extract) | ✅ Selamanya |
| `messages` | Riwayat chat per user | ✅ Max 60 pesan terakhir per user |
| `sessions` | Skill aktif, verbose level, workspace per user | ✅ |
| `skills` | Custom skill yang di-install | ✅ |
| `auditlogs` | Audit trail command + tool call | ✅ |
| `webhookevents` | Dedup webhook GitHub/generic | ✅ |
| `scheduledjobs` | Cron job persisten | ✅ |
| `projects` | Workspace registry multi-project | ✅ |

Jika `MONGODB_URI` tidak diset, semua data otomatis fallback ke file JSON lokal (⚠️ hilang saat redeploy).



### 1. Fork & Setup

```bash
git clone <repo-url>
cd cpamc-railway-v3
npm install
```

### 2. Environment Variables

Copy `.env.example` ke `.env` dan isi:

```env
# WAJIB
CPAMC_BASE_URL=https://cli-proxy-api-production-9440.up.railway.app/v1
CPAMC_API_KEY=dummy
TELEGRAM_BOT_TOKEN=your_token_here

# OPSIONAL
OPENAI_API_KEY=sk-...     # untuk transkripsi voice
ALLOWED_USERS=123456789   # whitelist user ID
MODEL=claude-sonnet-4-5
```

### 3. Push ke Railway

Di Railway dashboard: New Project → Deploy from GitHub → pilih repo ini.

Set environment variables di **Settings > Variables**.

## 📱 Penggunaan Telegram

### Commands

Daftar lengkap (juga muncul di Telegram saat user ketik `/`) ada di **[docs/FEATURES.md](docs/FEATURES.md)**.

**Sesi:**

| Command | Fungsi |
|---------|--------|
| `/start` | Sambutan & panduan |
| `/help` | Bantuan lengkap |
| `/new` | Mulai sesi baru (hapus history) |
| `/clear` | Alias `/new` |
| `/stop` | Hentikan tool loop yang sedang jalan |
| `/status` | Info engine & stats |
| `/verbose 0\|1\|2` | Atur level verbose tool call |

**Memory & Skills:**

| Command | Fungsi |
|---------|--------|
| `/skills` | Lihat semua skill |
| `/skill <nama>` | Aktifkan/matikan skill |
| `/memory` | Lihat memori tersimpan |
| `/remember <teks>` | Simpan ke memori |
| `/forget [N]` | Hapus memori |
| `/search <query>` | Cari di memori |

**Workspace & Git:**

| Command | Fungsi |
|---------|--------|
| `/pwd` | Workspace aktif |
| `/ls` | List isi workspace |
| `/cd <name>` | Pindah ke workspace lain |
| `/projects` | List project terdaftar |
| `/git status\|log\|diff` | Shortcut git |

**Automation & Audit:**

| Command | Fungsi |
|---------|--------|
| `/jobs` | List scheduled cron job |
| `/audit` | 10 audit entry terakhir |
| `/export [md\|json\|html]` | Export session |

### Media

- 🖼️ **Kirim foto** → analisis visual otomatis
- 📎 **Upload file** → analisis kode/teks
- 🎤 **Voice message** → transkripsi (butuh `OPENAI_API_KEY`)
- 📋 **Paste gambar** → analisis langsung di dashboard

### Agentic Mode

Bot otomatis menggunakan tools:
- `execute_command` — jalankan bash di workspace
- `read_file` / `write_file` — baca/tulis file
- `list_dir` — navigasi direktori
- `git_status` / `git_log` / `git_diff` — operasi Git

## 🔧 Skills Tersedia

| Skill | Trigger |
|-------|---------|
| assistant | tanya, bantu, tolong |
| coding | kode, script, program, bug |
| analyst | analisis, data, laporan |
| creative | cerita, kreatif, ide |
| writer | tulis, artikel, konten |
| teacher | ajar, jelaskan, tutorial |
| translator | terjemah, translate |

## 🛠️ Tambah Skill Baru

Via dashboard web → ➕ Skill, atau via API:

```bash
curl -X POST http://localhost:3000/api/skills \
  -H "Content-Type: application/json" \
  -d '{
    "name": "seo-expert",
    "description": "Ahli SEO",
    "triggers": ["seo", "ranking", "keyword"],
    "prompt": "Kamu adalah ahli SEO berpengalaman..."
  }'
```

## 📊 API Endpoints

```
# Core
GET    /api/status              — stats engine
POST   /api/chat                — kirim pesan
GET    /api/models              — list model dari 9router
POST   /api/models/select       — ganti model aktif

# Skills
GET    /api/skills              — list skills
POST   /api/skills              — install skill
DELETE /api/skills/:name        — hapus skill

# Memory
GET    /api/memory/:userId      — get memori
POST   /api/memory/:userId      — tambah memori
DELETE /api/memory/:userId      — hapus semua memori
GET    /api/memory/:userId/search/:query  — cari memori

# Session
GET    /api/session/:userId     — metadata sesi
DELETE /api/session/:userId     — reset sesi
POST   /api/session/:userId/stop — cancel tool loop
GET    /api/session/:userId/export?format=markdown  — export

# Audit
GET    /api/audit/:userId       — 50 entry terakhir
GET    /api/audit/stats         — total + error count

# Projects (workspace registry)
GET    /api/projects            — list workspace
POST   /api/projects            — register workspace baru
DELETE /api/projects/:name      — unregister

# Scheduled Jobs (cron)
GET    /api/jobs                — list job
POST   /api/jobs                — tambah job
DELETE /api/jobs/:jobId         — hapus job
POST   /api/jobs/:jobId/toggle  — enable/disable

# Notifications
POST   /api/notify              — broadcast ke Telegram

# Webhooks (incoming)
POST   /webhooks/github         — GitHub HMAC-SHA256
POST   /webhooks/:provider      — generic Bearer token
GET    /api/webhooks/recent     — list event terakhir
```

## 📁 Struktur Proyek

```
cpamc-railway-v3/
├── bot/
│   └── telegram.js           # Bot Telegram (text/photo/doc/voice + commands)
├── core/
│   ├── engine.js             # Agentic engine + agentic loop + commands
│   ├── db.js                 # MongoDB connection (mongoose)
│   ├── models.js             # Mongoose schemas (8 collections)
│   ├── memory.js             # Memory manager
│   ├── skills.js             # Skill manager (built-in + MongoDB custom)
│   ├── tools.js              # Tools (bash, file, git) sandbox per workspace
│   ├── projects.js           # Workspace registry (multi-project)
│   ├── rate_limiter.js       # Token-bucket rate limiter
│   ├── session_export.js     # Export MD/JSON/HTML
│   ├── audit.js              # Persistent audit trail
│   ├── webhook.js            # Express webhook routes (GitHub HMAC + Bearer)
│   ├── scheduler.js          # node-cron + persisted jobs
│   ├── notifications.js      # Rate-limited Telegram broadcaster
│   └── model_detector.js     # Auto-detect model dari 9router
├── dashboard/
│   ├── server.js             # Express + WebSocket + REST API
│   └── public/
│       └── index.html        # Web dashboard
├── docs/
│   ├── RAILWAY_MONGODB_SETUP.md  # Panduan lengkap setup
│   └── FEATURES.md               # Reference fitur
├── skills/                   # Built-in skills (JSON)
├── data/                     # User data fallback (auto-created)
├── workspace/                # Sandbox tool (auto-created)
├── .env.example
├── railway.json
└── package.json
```
