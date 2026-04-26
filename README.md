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

## 🍃 Setup MongoDB Atlas (GitHub Student)

Karena kamu punya MongoDB Atlas via GitHub Student Pack, ikuti langkah berikut:

### 1. Buat Cluster
1. Login ke [cloud.mongodb.com](https://cloud.mongodb.com)
2. Klik **New Project** → beri nama `cpamc`
3. **Build a Cluster** → pilih **M0 Free** (atau M10 kalau pakai kredit student)
4. Pilih region terdekat (Singapore untuk Indonesia)

### 2. Buat Database User
1. **Security → Database Access** → Add New Database User
2. Username: `cpamc`, Password: (generate yang kuat, simpan)
3. Role: **Atlas Admin** atau **Read and write to any database**

### 3. Whitelist IP
1. **Security → Network Access** → Add IP Address
2. Pilih **Allow access from anywhere** (`0.0.0.0/0`) untuk Railway

### 4. Dapatkan Connection String
1. **Deployment → Database** → klik **Connect**
2. Pilih **Drivers** → Node.js
3. Copy connection string, ganti `<password>` dengan password user tadi
4. Contoh: `mongodb+srv://cpamc:PASSWORD@cluster0.xxxxx.mongodb.net/cpamc`

### 5. Set di Railway
Di Railway dashboard → Settings → Variables:
```
MONGODB_URI=mongodb+srv://cpamc:PASSWORD@cluster0.xxxxx.mongodb.net/cpamc
```

### ✅ Yang Disimpan di MongoDB
| Data | Persisten? |
|------|-----------|
| Memory (facts, notes) | ✅ Selamanya |
| History percakapan | ✅ Max 60 pesan terakhir per user |
| Custom skills | ✅ Selamanya |
| Session metadata | ✅ (skills aktif, statistik) |

Jika `MONGODB_URI` tidak diset, semua data otomatis fallback ke file JSON lokal.



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

| Command | Fungsi |
|---------|--------|
| `/start` | Sambutan & panduan |
| `/help` | Bantuan lengkap |
| `/skills` | Lihat semua skill |
| `/skill <nama>` | Aktifkan/matikan skill |
| `/memory` | Lihat memori tersimpan |
| `/remember <teks>` | Simpan ke memori |
| `/forget [nomor]` | Hapus memori |
| `/search <query>` | Cari di memori |
| `/export [md\|json\|html]` | Export session |
| `/status` | Info engine & stats |
| `/clear` | Hapus history chat |

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
GET  /api/status              — stats engine
POST /api/chat                — kirim pesan
GET  /api/skills              — list skills
POST /api/skills              — install skill
DELETE /api/skills/:name      — hapus skill
GET  /api/memory/:userId      — get memori
POST /api/memory/:userId      — tambah memori
DELETE /api/memory/:userId    — hapus semua memori
GET  /api/session/:userId/export?format=markdown  — export session
```

## 📁 Struktur Proyek

```
cpamc-railway-v3/
├── bot/
│   └── telegram.js          # Bot Telegram enhanced
├── core/
│   ├── engine.js            # Agentic engine utama
│   ├── memory.js            # Memory manager
│   ├── skills.js            # Skill manager
│   ├── tools.js             # Tools (bash, file, git)
│   ├── rate_limiter.js      # Rate limiting
│   └── session_export.js    # Export session
├── dashboard/
│   ├── server.js            # Express + WebSocket
│   └── public/
│       └── index.html       # Web dashboard
├── skills/                  # Built-in skills (JSON)
├── data/                    # User data (auto-created)
├── workspace/               # Sandbox untuk tools (auto-created)
├── .env.example
├── railway.json
└── package.json
```
