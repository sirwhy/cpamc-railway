# Setup MongoDB Atlas + Railway untuk CPAMC AI v3

Panduan lengkap menyambungkan **MongoDB Atlas** (gratis via GitHub Student Developer Pack) dengan deployment **Railway** sehingga setiap chat bot menyimpan memori secara persisten.

> **Kenapa MongoDB?** Tanpa MongoDB, data (memori, history chat, custom skill, scheduled job, audit log) hanya tersimpan di file JSON lokal yang **hilang setiap kali Railway redeploy**. Dengan MongoDB Atlas, data tahan restart dan tahan re-deploy.

---

## 1. Aktivasi GitHub Student Developer Pack

1. Buka [https://education.github.com/pack](https://education.github.com/pack) → **Get the Pack**.
2. Verifikasi sebagai pelajar (kartu pelajar / surat keterangan / email kampus).
3. Setelah disetujui, di halaman benefits cari **MongoDB**:
   - **MongoDB Atlas** — kredit USD 50 + akses M0 free tier seumur hidup.
   - **MongoDB University** — akses kursus gratis (bonus).
4. Klik **Get access by connecting your GitHub** → akan mengarah ke MongoDB Atlas.

> Kalau belum terdaftar Student Pack, kamu tetap bisa pakai **M0 Free Cluster** standar (512 MB) tanpa biaya. Step-step di bawah berlaku sama.

---

## 2. Buat Project & Cluster di MongoDB Atlas

1. Login ke [cloud.mongodb.com](https://cloud.mongodb.com).
2. Klik **+ New Project** → kasih nama `cpamc` → **Next** → **Create Project**.
3. Klik **+ Build a Database**.
4. Pilih:
   - **M0** (FREE) — cukup untuk bot Telegram pribadi/komunitas kecil.
   - **M10** atau lebih besar — kalau punya kredit student dan butuh lebih banyak storage / performa.
5. **Cloud provider & region**:
   - Untuk Indonesia: pilih **AWS — Singapore (ap-southeast-1)** untuk latency terendah.
   - Pastikan region cluster kamu **sama atau dekat dengan region Railway** kamu (Railway default `us-west`, jadi kalau bot trafiknya bukan dari Indonesia, pertimbangkan AWS Oregon).
6. **Cluster name**: bebas, misal `cpamc-cluster`.
7. Klik **Create**.

Tunggu ~1-3 menit hingga cluster siap.

---

## 3. Buat Database User

1. Saat cluster baru dibuat, Atlas akan otomatis menampilkan **Security Quickstart**.
2. **Username**: `cpamc` (boleh apa saja).
3. **Password**: klik **Autogenerate Secure Password** → **Copy** dan **simpan baik-baik** — kita akan masukkan ke Railway nanti.
4. **Database User Privileges**: pilih **Read and write to any database**.
5. Klik **Create User**.

> Kalau lewat dialog ini, buka **Security → Database Access → + Add New Database User** untuk membuatnya manual.

---

## 4. Whitelist IP Railway

Railway memberikan IP outbound yang **dinamis**, jadi cara paling aman untuk bot pribadi adalah whitelist `0.0.0.0/0` (allow from anywhere) yang dikombinasikan dengan password kuat dari step 3.

1. Buka **Security → Network Access → + Add IP Address**.
2. Klik **ALLOW ACCESS FROM ANYWHERE** → confirm `0.0.0.0/0`.
3. **Comment**: `Railway deployment` → **Confirm**.

> **Mau lebih aman?** Aktifkan **Atlas Private Endpoint** (perlu cluster M10+) atau gunakan **Railway Static Outbound IP** (paid feature) lalu whitelist hanya IP tersebut. Untuk M0 free, opsi `0.0.0.0/0` + password kuat sudah cukup aman.

---

## 5. Dapatkan Connection String

1. Kembali ke **Database** → klik **Connect** pada cluster kamu.
2. Pilih **Drivers** (bukan Compass).
3. **Driver**: `Node.js`, **Version**: `5.5 or later`.
4. Copy URI yang ditampilkan, contoh:
   ```
   mongodb+srv://cpamc:<password>@cpamc-cluster.abcde.mongodb.net/?retryWrites=true&w=majority&appName=cpamc-cluster
   ```
5. **Ganti** `<password>` dengan password user yang kamu copy di step 3.
6. **Tambahkan** nama database `/cpamc` sebelum `?` supaya semua collection mendarat di satu database:
   ```
   mongodb+srv://cpamc:PASSWORDMU@cpamc-cluster.abcde.mongodb.net/cpamc?retryWrites=true&w=majority&appName=cpamc-cluster
   ```

> **Penting:** kalau password kamu mengandung karakter spesial (`@`, `:`, `/`, `?`, `#`, `[`, `]`, `%`), URL-encode dulu. Contoh: `p@ss` → `p%40ss`. Cara paling gampang: regenerate password di Atlas yang hanya berisi huruf+angka.

---

## 6. Set di Railway

### Cara A — Lewat Web Dashboard (paling gampang)

1. Buka [railway.app](https://railway.app/dashboard) → pilih project kamu.
2. Klik service `cpamc-railway` → tab **Variables**.
3. Klik **+ New Variable** dan isi:

| Key | Value |
|-----|-------|
| `MONGODB_URI` | (paste connection string lengkap dari step 5) |
| `TELEGRAM_BOT_TOKEN` | (token dari @BotFather) |
| `CPAMC_BASE_URL` | `https://cli-proxy-api-production-9440.up.railway.app/v1` |
| `CPAMC_API_KEY` | `dummy` |
| `ALLOWED_USERS` | `123456789` (Telegram ID kamu, opsional tapi direkomendasikan) |
| `OPENAI_API_KEY` | (opsional — untuk fitur transkripsi voice) |
| `NOTIFICATION_CHAT_IDS` | (opsional — chat ID untuk webhook/scheduler broadcast) |
| `ENABLE_SCHEDULER` | `false` (set `true` kalau mau pakai cron jobs) |

4. Klik **Deploy** → tunggu Railway redeploy.

### Cara B — Lewat Railway CLI

```bash
railway login
railway link            # pilih project
railway variables set MONGODB_URI="mongodb+srv://cpamc:PASSWORDMU@..."
railway variables set TELEGRAM_BOT_TOKEN="123:ABC..."
railway variables set ALLOWED_USERS="123456789"
railway up
```

---

## 7. Verifikasi Koneksi

Setelah Railway selesai redeploy, buka tab **Logs** dan cari:

```
✅ MongoDB terhubung
✅ CPAMC AI Server v3 jalan di port 3000
✅ Telegram Bot dimulai
✅ CPAMC Telegram Bot v3 aktif!
```

Kalau muncul:
```
⚠️  MONGODB_URI tidak diset — fallback ke penyimpanan file lokal.
```
artinya env var belum ke-pickup — pastikan kamu sudah klik **Deploy** setelah set variabel.

Kalau muncul:
```
❌ MongoDB gagal terhubung: ...
```
- Cek password tidak punya karakter spesial yang lupa di-URL-encode.
- Cek Network Access di Atlas sudah include `0.0.0.0/0`.
- Cek nama cluster di URI sama persis dengan yang di Atlas.

### Tes dari Telegram

1. Chat bot kamu di Telegram → kirim `/start`.
2. Kirim: `Tolong ingat nama saya Andi`.
3. Kirim `/memory` → harus muncul `1. [auto] Nama user: Andi`.
4. **Restart Railway** (Dashboard → Deployments → … → Restart).
5. Setelah bot online lagi, kirim `/memory` lagi → memori `Andi` masih ada → **MongoDB persistence berhasil.**

---

## 8. Apa Saja yang Tersimpan di MongoDB?

Semua data per-user di-namespace berdasarkan Telegram User ID, jadi memori antar user tidak bercampur.

| Collection | Isi | Endpoint API |
|-----------|------|---------------|
| `memories` | Fakta/preferensi user (manual + auto-extract) | `/api/memory/:userId` |
| `messages` | Riwayat chat per user (max 60 pesan) | `/api/session/:userId` |
| `sessions` | Metadata sesi: skill aktif, verbose level, workspace | `/api/session/:userId` |
| `skills` | Custom skill yang di-install user | `/api/skills` |
| `auditlogs` | Audit trail command, tool call, webhook, auth | `/api/audit/:userId` |
| `webhookevents` | Dedup webhook delivery | `/api/webhooks/recent` |
| `scheduledjobs` | Cron job persisten | `/api/jobs` |
| `projects` | Workspace registry (multi-project) | `/api/projects` |

---

## 9. Setup Webhook GitHub (Opsional)

Bot bisa menerima webhook GitHub (push, PR, issue, workflow) dan broadcast ke Telegram.

1. Generate secret acak (di terminal local):
   ```bash
   openssl rand -hex 32
   ```
2. Set di Railway: `GITHUB_WEBHOOK_SECRET=<hasil-step-1>`.
3. Set juga `NOTIFICATION_CHAT_IDS=<chat-id-kamu>` agar webhook broadcast ke kamu.
4. Di GitHub → repo → **Settings → Webhooks → Add webhook**:
   - **Payload URL**: `https://your-app.up.railway.app/webhooks/github`
   - **Content type**: `application/json`
   - **Secret**: paste hasil step 1
   - **SSL verification**: Enable
   - **Events**: pilih sesuai kebutuhan (default: `Just the push event` sudah cukup)
5. Klik **Add webhook** → GitHub akan kirim ping → cek log Railway harus ada `[AUDIT] action=webhook ...`.

Set `WEBHOOK_TRIGGER_AI=true` kalau mau bot otomatis kasih komentar AI tiap kali ada push/PR.

---

## 10. Setup Scheduler (Opsional)

Cron job persisten yang otomatis kirim prompt ke AI dan broadcast hasilnya ke Telegram.

1. Set `ENABLE_SCHEDULER=true` di Railway.
2. Set `NOTIFICATION_CHAT_IDS=<chat-id-kamu>` supaya hasil job dikirim ke kamu.
3. Tambah job lewat API:
   ```bash
   curl -X POST https://your-app.up.railway.app/api/jobs \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Daily standup reminder",
       "cronExpression": "0 9 * * 1-5",
       "prompt": "Bikin reminder daily standup yang lucu dan motivating buat tim engineering hari ini.",
       "targetChatIds": ["123456789"]
     }'
   ```
4. Cek dengan `/jobs` di Telegram atau `GET /api/jobs`.

Format cron: `menit jam tanggal bulan hari` (5 field standard).

---

## 11. Backup MongoDB (Recommended)

Atlas M0 tidak punya automated backup. Backup manual:

```bash
mongodump --uri="mongodb+srv://cpamc:PASS@cluster..." --out=./backup-$(date +%F)
```

Atau pakai **Atlas Live Migration** kalau upgrade ke M10+.

---

## 12. Troubleshooting

| Gejala | Solusi |
|--------|--------|
| `MongooseServerSelectionError: connect ECONNREFUSED` | Cek Network Access di Atlas — pastikan `0.0.0.0/0` ditambahkan. |
| `Authentication failed` | Password salah / belum di-URL-encode. Regenerate user password (huruf+angka saja). |
| `bad auth : authentication failed` | Username/password tidak match — pastikan database user di Atlas sama dengan yang di URI. |
| `Bot tidak respons di Telegram` | Cek Railway log: kalau muncul `409 Conflict`, kamu running 2 instance bot dengan token sama. Stop instance lama. |
| Memori hilang setelah redeploy | `MONGODB_URI` belum diset / typo. Cek log: harus muncul `✅ MongoDB terhubung`. |
| `429 Too Many Requests` dari Telegram | Notifications service sudah rate-limit ke ~1 pesan/detik per chat — jangan kirim ratusan job barengan. |

---

## 13. Refresh Connection String

Kalau password bocor:
1. Atlas → **Database Access** → klik **Edit** pada user → **Edit Password** → autogenerate.
2. Update `MONGODB_URI` di Railway dengan password baru.
3. Trigger redeploy.

---

Selesai! Bot kamu sekarang punya memori persisten via MongoDB Atlas, plus webhook + scheduler kalau diaktifkan. 🚀
