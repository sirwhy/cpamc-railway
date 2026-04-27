# 9Router Setup — CPAMC Railway

[9Router](https://github.com/decolua/9router) adalah local AI router yang me-expose
endpoint OpenAI-compatible (`http://localhost:20128/v1`) lalu meneruskan request ke
40+ provider (Claude Code subscription, Codex, Gemini CLI, GLM, MiniMax, iFlow, Qwen,
Kiro, OpenRouter, dll.) dengan **auto-fallback** subscription → cheap → free.

CPAMC v3.1 sudah **fully compatible** dengan 9router via auto-detect di
`core/model_detector.js` (prefix-aware: `<provider>/<model>` ataupun bare).

---

## TL;DR — Pakai 9router lokal dengan CPAMC

1. **Install 9router:**
   ```bash
   npm install -g 9router
   9router
   ```
   Dashboard otomatis terbuka di `http://localhost:20128`.

2. **Connect minimal 1 provider** di dashboard 9router:
   - **Free tanpa signup:** Claude Code OAuth, Antigravity, iFlow, Qwen, Kiro
   - **Cheap:** GLM ($0.6/1M), MiniMax ($0.2/1M)
   - **Berbayar:** OpenAI / Anthropic / OpenRouter API key

3. **Set CPAMC env vars** (di `.env` lokal atau Railway Settings):
   ```bash
   CPAMC_BASE_URL=http://localhost:20128/v1
   CPAMC_API_KEY=dummy   # 9router default REQUIRE_API_KEY=false
   MODEL=                # kosongkan → auto-detect best model
   ```

4. **Boot CPAMC:**
   ```bash
   npm start
   ```
   Log akan tampil:
   ```
   ✅ CPAMC AI Server v3 jalan di port 3000
      API       : http://localhost:20128/v1 (9router)
      Model     : anthropic/claude-sonnet-4-5 (auto, dari 47 model)
   ```

5. **Selesai.** Setiap chat ke Telegram bot atau dashboard akan diteruskan ke 9router
   yang otomatis pilih provider termurah/tersedia dengan fallback.

---

## Cara Auto-Detect Model Bekerja

Saat `MODEL=` kosong, CPAMC ambil daftar model dari `GET /v1/models` dan pilih yang
paling powerful via priority list. **Prefix-aware** — artinya:

| Yang ada di 9router `/v1/models`     | Yang dipilih CPAMC                |
|--------------------------------------|-----------------------------------|
| `anthropic/claude-sonnet-4-5`        | dipilih (preferred match)         |
| `openai/gpt-4o`                      | dipilih kalau Claude tidak ada    |
| `or/glm-4.5`                         | dipilih sebagai fallback (cheap)  |
| `gemini/gemini-2.5-pro`              | dipilih sebagai fallback          |
| `combo-name`                         | dipilih bila ada combo bernama    |

Priority list lengkap ada di [`core/model_detector.js:35`](../core/model_detector.js#L35).

### Override manual

Kalau ingin force model tertentu, set env `MODEL`:

```bash
MODEL=anthropic/claude-sonnet-4-5  # force Anthropic via 9router subscription
MODEL=openai/gpt-4o                # force OpenAI
MODEL=or/glm-4.5                   # force GLM cheap
MODEL=claude-sonnet-4-5            # bare ID — biarkan 9router auto-route ke provider mana
```

### Cek status di runtime

- Telegram: `/status` → tampil model aktif + sumber + jumlah model tersedia.
- Dashboard API: `GET /api/status` → field `modelInfo` berisi `is9Router`, `upstream`,
  `selected`, `available`, `total`.

---

## Mode Deploy 9router

### Mode 1 — 9router lokal (development)

```
Telegram ── Telegraf ── CPAMC engine ── localhost:20128/v1 (9router) ── 40+ providers
```

Cocok untuk:
- Development di laptop
- Test/eksperimen route fallback

### Mode 2 — 9router di server, CPAMC di Railway

Karena 9router perlu OAuth login (Claude Code subscription, Codex, dll), biasanya
dijalankan di mesin yang user kontrol penuh. Expose ke Railway via tunnel:

```bash
# Di mesin 9router:
npm install -g 9router
9router

# Expose via Cloudflare Tunnel (gratis, recommended)
cloudflared tunnel --url http://localhost:20128
# → keluar URL: https://random-words.trycloudflare.com
```

Lalu di Railway Settings → Variables:
```bash
CPAMC_BASE_URL=https://random-words.trycloudflare.com/v1
CPAMC_API_KEY=<key>   # set REQUIRE_API_KEY=true di 9router untuk security
```

Jangan lupa di 9router (`.env` di mesin lokal):
```bash
REQUIRE_API_KEY=true
API_KEY_SECRET=<same-key-as-CPAMC_API_KEY>
```

### Mode 3 — 9router di Railway juga (advanced)

9router bisa dijalankan di Railway service terpisah, tapi OAuth provider Claude Code
butuh interactive login pertama kali — kurang praktis. Kalau memang ingin:

- Service 1: cpamc-railway (this repo)
- Service 2: 9router (separate Railway service)
- Set `CPAMC_BASE_URL=http://9router.railway.internal:20128/v1` di service 1
- Login OAuth via 9router dashboard URL Railway

---

## Troubleshooting

### "Gagal fetch model list: connect ECONNREFUSED 127.0.0.1:20128"
- 9router belum jalan. Boot dengan `9router` di terminal terpisah.
- Atau ganti `CPAMC_BASE_URL` ke cloud proxy CPAMC default.

### Model selalu fallback ke `claude-sonnet-4-5` padahal 9router jalan
- Cek `GET http://localhost:20128/v1/models` — apakah list-nya kosong?
- Buka 9router dashboard, **enable** minimal 1 provider connection.
- Cek log boot CPAMC — kalau tampil "auto, dari 0 model", artinya `/v1/models`
  return empty.

### "401 Unauthorized" dari 9router
- Default 9router lokal: `REQUIRE_API_KEY=false`. Pastikan env tersebut tidak di-override.
- Kalau memang `REQUIRE_API_KEY=true`, set `CPAMC_API_KEY=<API_KEY_SECRET 9router>`.

### Model dipilih bukan yang terbaik (mis. dapat GLM padahal Anthropic ada)
- Cek priority list di `core/model_detector.js:35`.
- Atau force dengan `MODEL=anthropic/claude-sonnet-4-5`.

### Format request error "model X not found"
- 9router menerima exact ID dari `/v1/models`. Auto-detect sudah pakai ID exact.
- Kalau set `MODEL=` manual, copy ID dari `GET /v1/models` apa adanya.

---

## Quota Tracking

9router track quota tiap provider. Akses dashboard `http://localhost:20128` untuk
lihat sisa quota subscription. CPAMC tidak perlu peduli — request akan otomatis
fall through ke tier berikutnya kalau quota habis.

---

## Endpoint yang Dipakai CPAMC

| Endpoint                  | Method | Format       | Untuk                           |
|---------------------------|--------|--------------|---------------------------------|
| `/v1/models`              | GET    | OpenAI       | Auto-detect daftar model        |
| `/v1/chat/completions`    | POST   | OpenAI       | Chat utama (streaming=false)    |

CPAMC tidak pakai `/v1/messages` (Anthropic format) karena agentic tool loop
memakai output OpenAI yang sudah diparse via XML tag `<tool_call>`.
