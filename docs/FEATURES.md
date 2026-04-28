# CPAMC AI v3 — Feature Reference

Dokumentasi lengkap fitur yang diport dari [claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) (Python) ke CPAMC Railway (Node.js).

## Ringkasan

| Kategori | Fitur claude-code-telegram (Python) | Status di CPAMC v3 (JS) |
|----------|-------------------------------------|--------------------------|
| **Bot core** | Telegram polling, command handler | ✅ `bot/telegram.js` |
| **Auth** | Whitelist (`ALLOWED_USERS`) | ✅ + audit log |
| **Rate limit** | Token bucket per user | ✅ `core/rate_limiter.js` |
| **Memory** | Per-session + persistent (SQLite) | ✅ MongoDB-based, fallback file |
| **History** | Auto-trim, max 60 msg | ✅ MongoDB `messages` collection |
| **Skills/Modes** | YAML registry | ✅ JSON file + MongoDB custom |
| **Voice** | Whisper API transcription | ✅ OpenAI Whisper |
| **Image** | Photo + paste analysis | ✅ via vision-capable model |
| **File upload** | Code/text inspection | ✅ |
| **Quick actions** | Inline keyboard | ✅ context-aware |
| **Draft streaming** | Live "typing" updates | ✅ `DraftStreamer` class |
| **Session export** | MD/JSON/HTML | ✅ `core/session_export.js` |
| **Workspace cd/ls/pwd** | Per-session directory | ✅ `core/projects.js` + tools `_workspace` |
| **Multi-project** | Topic threads | ⚠️ Project registry only (no Telegram topic threads) |
| **Tool monitor** | Pre-flight tool validation | ⚠️ Sandbox via `WORKSPACE_DIR` saja |
| **Audit log** | SQLite persistent | ✅ `core/audit.js` (MongoDB) |
| **Verbose level** | Per-session 0/1/2 | ✅ `/verbose` |
| **`/new` command** | Reset session | ✅ |
| **`/stop` button** | Cancel running tool loop | ✅ `/stop` command + cancellation flag |
| **Webhook server** | FastAPI GitHub HMAC + Bearer | ✅ Express via `core/webhook.js` |
| **Webhook dedup** | Atomic INSERT | ✅ unique compound index |
| **Scheduler** | APScheduler (cron) | ✅ `node-cron` + MongoDB persist |
| **Notifications** | Rate-limited Telegram | ✅ `core/notifications.js` |
| **Event bus** | Async pub/sub | ⚠️ Direct method calls (lebih sederhana) |
| **MCP server** | Model Context Protocol | ❌ skip (di luar scope Railway-friendly) |
| **Project topic threads** | Telegram supergroup topics | ❌ skip (butuh setup grup khusus) |
| **Web dashboard** | (tidak ada) | ✅ Express + WebSocket bonus |

---

## Telegram Commands (lengkap)

| Command | Aliases | Fungsi |
|---------|---------|--------|
| `/start` | — | Sambutan + panduan singkat |
| `/help` | `!help` | Bantuan lengkap |
| `/new` | `!new` | Mulai sesi baru (hapus history) |
| `/clear` | `!clear` | Alias `/new` |
| `/stop` | `!stop` | Hentikan tool loop yang sedang jalan |
| `/status` | `!status` | Info engine, model, memori, rate limit, dll. |
| `/verbose` | `!verbose 0\|1\|2` | Atur level verbose (0=quiet, 1=normal, 2=detailed) |
| `/skills` | `!skills` | List skill (built-in + custom) |
| `/skill <nama>` | `!skill ...` | Toggle aktif/nonaktif skill |
| `/memory` | `!memory` | Lihat memori user |
| `/remember <teks>` | `!remember ...` | Simpan ke memori |
| `/forget [N]` | `!forget` | Hapus memori (semua atau ke-N) |
| `/search <query>` | `!search ...` | Cari di memori |
| `/pwd` | `!pwd` | Workspace aktif |
| `/ls` | `!ls` | List isi workspace aktif |
| `/cd <path>` | `!cd ...` | Pindah workspace |
| `/projects` | `!projects` | List workspace terdaftar |
| `/git [sub]` | `!git ...` | Shortcut git: `status`, `log [N]`, `diff [file]` |
| `/jobs` | `!jobs` | List scheduled job |
| `/audit` | `!audit` | 10 audit entry terakhir untuk user ini |
| `/export [fmt]` | `!export md\|json\|html` | Export session ke file |

---

## Workspace & Per-Session State

Setiap user punya:
- `workspace` — direktori aktif (relatif ke `/workspace`)
- `verboseLevel` — 0 / 1 / 2
- `activeSkills` — list nama skill aktif
- `conversationMode` — `auto` / `strict` / `off`
- `history` — riwayat chat (max 60 pesan)

Semua tool calls (`execute_command`, `read_file`, `write_file`, dll.) otomatis di-scope ke workspace aktif user. Saat user ketik `/cd backend`, semua tool berikutnya jalan di `/workspace/backend/...`.

### Project Registry

Workspace bisa diberi nama via `/api/projects`:

```bash
curl -X POST https://app/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "myproject",
    "path": "myproject-backend",
    "description": "Backend Python utama",
    "triggers": ["backend", "api server"]
  }'
```

Setelah register, user bisa:
- `/cd myproject` — pindah workspace
- `/projects` — lihat list

---

## Webhooks

### GitHub

Endpoint: `POST /webhooks/github`

Verifikasi: HMAC-SHA256 dari header `X-Hub-Signature-256` vs body raw.

Set `GITHUB_WEBHOOK_SECRET` lalu di GitHub repo settings → Webhooks → tambah secret yang sama.

Payload yang dikenali summary-nya:
- `push` → daftar commit
- `pull_request` → judul + URL PR
- `issues` → judul + URL issue
- `workflow_run` → status workflow

Set `WEBHOOK_TRIGGER_AI=true` untuk auto-respons via AI.

### Generic Provider

Endpoint: `POST /webhooks/<provider>` (misal `/webhooks/sentry`).

Verifikasi: `Authorization: Bearer <WEBHOOK_API_SECRET>`.

Header opsional:
- `X-Event-Type: <type>`
- `X-Delivery-ID: <unique-id>`

### Dedup

Setiap delivery direkam ke collection `webhookevents` dengan unique index `(provider, deliveryId)`. Re-delivery akan kembalikan `{"status": "duplicate"}` tanpa side effect.

---

## Scheduler (Cron Jobs)

Aktifkan dengan `ENABLE_SCHEDULER=true`. Tambah job:

```bash
POST /api/jobs
{
  "name": "Daily standup",
  "cronExpression": "0 9 * * 1-5",
  "prompt": "Buatkan ringkasan standup harian untuk tim engineering",
  "targetChatIds": ["123456789"],
  "workingDirectory": "myproject"
}
```

Format cron: 5 field — `menit jam tanggal bulan hari`. Contoh:
- `0 9 * * 1-5` — Senin-Jumat jam 09:00
- `*/15 * * * *` — tiap 15 menit
- `0 0 1 * *` — tiap tanggal 1 jam 00:00

Saat job fire, engine.chat dipanggil dengan prompt → output di-broadcast ke `targetChatIds` via NotificationService.

API:
- `GET /api/jobs` — list
- `POST /api/jobs/:jobId/toggle` — enable/disable
- `DELETE /api/jobs/:jobId`

---

## Notifications (Broadcast)

Rate-limited ke ~1 pesan/detik per chat (Telegram limit). Pakai untuk:

- Webhook → broadcast ke `NOTIFICATION_CHAT_IDS`.
- Scheduler → kirim ke `targetChatIds`.
- Manual via API:

```bash
POST /api/notify
{ "chatId": "123456789", "text": "Pesan custom" }
```

Atau broadcast ke semua default chat:
```bash
POST /api/notify
{ "text": "Pesan untuk semua" }
```

---

## Audit Log

Setiap aksi penting dicatat ke MongoDB `auditlogs`:

- `command` — user ketik /command
- `tool_call` — engine eksekusi tool
- `webhook` — webhook diterima
- `auth` — user dicek (sukses/gagal)
- `error` — error tak terduga
- `notification` — pesan dikirim NotificationService
- `chat` — chat selesai (loop count, history len)
- `scheduler_*` — add / remove / job_run

API:
- `GET /api/audit/:userId` — 50 entry terakhir
- `GET /api/audit/stats` — total + error count
- `/audit` di Telegram — 10 entry terakhir milik user

---

## Tool System

8 tool agentic, semua di-scope per-session ke `workspace`:

1. `execute_command` — bash di workspace
2. `read_file` — baca file
3. `write_file` — tulis file (auto-mkdir)
4. `list_dir` — list folder
5. `delete_file` — hapus file
6. `git_status` — git status --short + branch
7. `git_log` — git log --oneline -N
8. `git_diff` — git diff [file]

Tool dipanggil oleh AI dengan format XML:
```
<tool_call>
{"name": "read_file", "args": {"filepath": "src/main.js"}}
</tool_call>
```

Engine inject `_workspace` otomatis dari session, AI tidak perlu kirim sendiri.

---

## Skills System

Built-in skills (`/skills/*.json`): assistant, coding, analyst, creative, writer, teacher, translator.

Custom skill via `POST /api/skills`:
```json
{
  "name": "seo-expert",
  "description": "Ahli SEO",
  "triggers": ["seo", "ranking", "keyword"],
  "prompt": "Kamu adalah ahli SEO senior..."
}
```

Auto-detection: trigger keyword dicek di setiap pesan user. Kalau match, skill otomatis aktif untuk pesan itu.

---

## Yang Tidak Diport

| Fitur | Alasan |
|-------|--------|
| **MCP Server** | Model Context Protocol butuh setup terminal/Claude CLI yang tidak masuk akal di lingkungan Railway containerized. CPAMC pakai HTTP API (`CPAMC_BASE_URL`) langsung. |
| **Project Topic Threads** | Butuh Telegram supergroup + admin permission. Workspace registry sederhana sudah meng-cover use case multi-project. |
| **Tool monitor (validators)** | Sandbox `WORKSPACE_DIR` + auth user sudah cukup untuk single-tenant deployment. Bisa ditambah nanti via PR terpisah. |
| **APScheduler + EventBus** | Diganti pola lebih sederhana: `node-cron` + direct method calls. Sufficient untuk skala bot pribadi. |
| **whisper.cpp local provider** | OpenAI Whisper API sudah cukup; container Railway tidak ramah binary native. |
