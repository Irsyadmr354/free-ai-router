# PROMPT UNTUK AI AGENT — Implementasi Token Saving Proxy di free-ai-router

Salin seluruh isi di bawah ini dan berikan ke AI coding agent (Claude Code, dsb) yang punya akses ke direktori proyek `free-ai-router`.

---

## MULAI PROMPT

Kamu bekerja di proyek `free-ai-router` (MCP server + HTTP proxy OpenAI-compatible yang route chat completion ke 7 provider LLM gratis dengan fallback otomatis). Tugasmu: **menambahkan modul Token Saving** — sistem penghematan token input/output yang powerful tapi aman (tidak menyebabkan halusinasi/kehilangan makna).

Baca dulu `ROADMAP.md`, `lib/router-core.js`, `lib/config.js`, `index.js`, dan `http-server.js` untuk memahami arsitektur yang ada sebelum mengubah apa pun. Fitur ini HARUS terintegrasi dengan alur `executeProviderChain()` di `lib/router-core.js`, dipakai oleh KEDUA entry point (`index.js` MCP dan `http-server.js` HTTP proxy), bukan diimplementasikan dua kali secara terpisah.

### Prinsip desain wajib (jangan dilanggar)

1. **Hierarki tier berdasarkan risiko halusinasi** — implementasikan persis 4 tier ini:
   - **Tier 0** (selalu ON, risiko 0%): deterministik murni, bisa dibuktikan reversible
   - **Tier 1** (default ON, risiko ~0%): deterministik + heuristik, tapi WAJIB transparan kalau ada data yang dipotong
   - **Tier 2** (opt-in via parameter, risiko rendah): lossy terkontrol, harus dihitung ROI-nya dulu sebelum diterapkan
   - **Tier 3** (opt-in eksplisit + wajib warning di response, risiko sedang-tinggi): pakai LLM untuk meringkas, default OFF

2. **Transparansi wajib** — setiap response (baik dari MCP tool maupun HTTP proxy) harus menyertakan metadata jujur tentang apa yang terjadi: berapa token dihemat, teknik apa yang dipakai, apakah ada context yang dipotong/hilang, dan warning eksplisit untuk operasi lossy. **DILARANG KERAS** silent data loss — ini pernah jadi bug kritis di proyek internal lain (`tokesave-mcp`) yang harus dihindari di sini.

3. **Urutan prioritas eksekusi**: cache/dedup dulu (paling besar ROI-nya, 100% hemat kalau hit) → baru kompresi (20-50% hemat) → baru opsi lossy kalau diminta eksplisit. Jangan buang waktu compute kompresi kalau cache hit.

4. **Semua teknik lossy harus menghitung ROI sebelum diterapkan** — kalau overhead metadata/legend lebih mahal dari yang dihemat, skip teknik itu otomatis dan laporkan di metadata bahwa itu di-skip karena tidak menguntungkan.

---

### Struktur file yang harus dibuat

Buat modul baru di `lib/token-saver.js` dengan fungsi-fungsi berikut. Ikuti gaya kode yang sudah ada di proyek ini (JSDoc lengkap di setiap fungsi, konfigurasi lewat env var dengan getter di `lib/config.js`, error handling yang tidak pernah throw untuk operasi opsional).

#### TIER 0 — Deterministik murni (selalu aktif, tidak butuh flag)

**1. `minifyStructuredContent(text, contentType)`**
- Deteksi apakah `context` atau bagian dari prompt berisi kode (JS/TS/JSON/CSS/HTML) berdasarkan heuristik sederhana (fence markdown ```` ```js ````, ekstensi file disebutkan, dsb) atau parameter eksplisit.
- Untuk JS/TS: gunakan library `terser` (tambahkan sebagai dependency di `package.json`) untuk minify AST-based — BUKAN regex. Kalau parsing gagal (bukan kode valid), kembalikan teks asli tanpa error, cukup log warning.
- Untuk JSON: `JSON.stringify(JSON.parse(text))` tanpa indentasi — kalau parse gagal, kembalikan asli.
- Untuk CSS: implementasikan minifier sederhana sendiri (strip komentar `/* */`, whitespace berlebih, atau tambahkan `csso`/`clean-css` sebagai dependency ringan) — pilih yang paling ringan dependency-nya.
- Return `{ text: minifiedText, originalTokenEstimate, minifiedTokenEstimate, applied: boolean }`.

**2. `normalizeWhitespace(text)`**
- Hapus trailing whitespace per baris.
- Kompres 3+ baris kosong berturut-turut jadi maksimal 1 baris kosong.
- Hapus spasi ganda di dalam kalimat (bukan di dalam blok kode — deteksi dulu apakah teks mengandung blok kode dan skip bagian itu).
- Ini SELALU jalan, tidak butuh flag, karena risikonya nol.

**3. Cache & dedup** — proyek ini SUDAH punya `lib/cache.js` dan `lib/dedup.js`. JANGAN buat ulang. Pastikan token-saver ini terintegrasi SETELAH cache check di `executeProviderChain()`, bukan sebelum atau menggantikannya.

#### TIER 1 — Deterministik + heuristik (default ON, bisa dimatikan via env var)

**4. `trimContextWindow(messages, options)`**
- Strategi: selalu pertahankan penuh pesan dengan `role: "system"`, selalu pertahankan `N` pesan terakhir (default `N=10`, konfigurasi via `CONTEXT_TRIM_KEEP_RECENT`), potong pesan-pesan lama di antaranya HANYA kalau total estimasi token melebihi `CONTEXT_TRIM_THRESHOLD_TOKENS` (default 8000, configurable).
- WAJIB return metadata: `{ messages: trimmedArray, trimmed: boolean, messagesDropped: number, droppedTurnRange: string }` — ini dipakai untuk transparansi ke user, JANGAN buang informasi ini.
- Jangan pernah memotong pesan terakhir milik user (pesan yang sedang ditanyakan sekarang) — itu akan merusak request.

**5. `deduplicateRepeatedBlocks(messages)`**
- Deteksi kalau ada blok teks identik (persis sama, exact string match, bukan semantic) yang muncul di lebih dari satu pesan dalam array `messages[]` — misal user paste dokumen yang sama dua kali di dua giliran berbeda.
- Ganti kemunculan kedua dan seterusnya dengan referensi singkat: `[konten identik dengan pesan sebelumnya — lihat referensi #N]` dan sisipkan penjelasan singkat di system prompt bahwa referensi ini valid.
- Threshold minimum: hanya proses blok yang panjangnya di atas `DEDUP_MIN_BLOCK_CHARS` (default 200 karakter) supaya tidak sia-sia memproses kalimat pendek yang kebetulan sama.

**6. Auto-stop pada streaming** — modifikasi `lib/sse-forward.js` atau `lib/router-core.js` (mana yang lebih tepat setelah kamu baca kodenya) untuk mendeteksi kalau model sudah mengeluarkan tanda akhir jawaban yang jelas (misal blok kode tertutup lalu tidak ada token baru dalam N ms, atau token `[DONE]`-equivalent) dan pertimbangkan early-stop — TAPI ini opsional dan berisiko memotong jawaban yang belum selesai, jadi berikan flag eksplisit `EARLY_STOP_ENABLED=false` (default OFF) untuk fitur ini karena risikonya lebih tinggi dari Tier 1 lain. Kalau ragu implementasinya terlalu berisiko, skip fitur ini dan cukup dokumentasikan di kode kenapa di-skip.

#### TIER 2 — Lossy terkontrol (opt-in via parameter per-request)

**7. `compactStructuredData(text)`**
- Deteksi data tabular dalam bentuk kalimat naratif berulang (pola seperti "Baris 1: kolom A adalah X, kolom B adalah Y. Baris 2: ...") dan tawarkan konversi ke CSV/TSV compact.
- HARUS opt-in lewat parameter, karena deteksi pola ini heuristik dan bisa salah pada teks yang kebetulan mirip.
- Return `{ text, applied, savingsEstimate }`.

**8. `applyAbbreviationDictionary(text, dictionary, options)`**
- Terima dictionary singkatan (bisa pakai yang sudah pernah dibuat sebelumnya di proyek lain — ID/JP/EN — atau default kosong dan user isi sendiri via parameter).
- WAJIB hitung dulu: apakah `estimateTokens(legend) + estimateTokens(compactedText) < estimateTokens(originalText)`? Kalau tidak, skip dan laporkan `applied: false, reason: "overhead lebih mahal dari penghematan"`.
- Kalau diterapkan, WAJIB sisipkan legend/definisi singkatan ke `system_prompt` yang dikirim ke model — JANGAN PERNAH kirim singkatan tanpa definisi eksplisit ke model, karena itu penyebab utama model salah tafsir/halusinasi.
- Return `{ text, legend, systemPromptAddition, applied, tokensSaved }`.

#### TIER 3 — LLM-based summarization (opt-in eksplisit, wajib warning)

**9. `summarizeContextViaLLM(text, options)`**
- Hanya dipanggil kalau caller eksplisit set parameter `allow_lossy_summarization: true` DAN context melebihi batas keras (`SUMMARIZATION_TRIGGER_TOKENS`, default 50000, configurable).
- Gunakan provider chat completion yang SUDAH ADA di `lib/router-core.js` (panggil `executeProviderChain` dengan model murah/cepat, jangan bikin panggilan API terpisah) dengan system prompt yang eksplisit meminta: "Ringkas teks berikut TANPA menghilangkan angka, nama, tanggal, keputusan, atau detail teknis penting. Fokus memadatkan penjelasan naratif, bukan membuang fakta."
- WAJIB return `{ summary, warning: "Ringkasan dibuat otomatis oleh LLM — detail mungkin hilang atau berubah, verifikasi manual disarankan", originalTokens, summarizedTokens }`.
- WAJIB log ke stderr setiap kali fungsi ini dipanggil (pakai `lib/logger.js` yang sudah ada) karena ini operasi paling berisiko di seluruh modul.

---

### Integrasi ke `lib/config.js`

Tambahkan getter-getter berikut mengikuti pola yang sudah ada di file itu (baca dulu contoh getter lain seperti `isModelFallbackEnabled()`, `getMaxTokensCap()` untuk konsistensi gaya):

```
isTokenSavingEnabled()              → env TOKEN_SAVING_ENABLED, default true
getContextTrimKeepRecent()          → env CONTEXT_TRIM_KEEP_RECENT, default 10
getContextTrimThresholdTokens()     → env CONTEXT_TRIM_THRESHOLD_TOKENS, default 8000
getDedupMinBlockChars()             → env DEDUP_MIN_BLOCK_CHARS, default 200
isStructuralMinifyEnabled()         → env STRUCTURAL_MINIFY_ENABLED, default true
getSummarizationTriggerTokens()     → env SUMMARIZATION_TRIGGER_TOKENS, default 50000
```

Tambahkan validasi numeric env var baru ini ke fungsi `validateConfig()` yang sudah ada (ada array `numericVars` di situ, tambahkan nama env var baru ke situ).

### Integrasi ke `lib/router-core.js`

Di dalam `executeProviderChain()`, SETELAH cache check (yang terjadi di `index.js`/`http-server.js` sebelum memanggil fungsi ini) dan SEBELUM loop `for (const providerName of order)`, panggil pipeline token-saver secara berurutan sesuai tier di atas. Simpan hasil metadata token-saving ke variable dan sisipkan ke `result._meta` (field ini sudah ada di kode, ikuti pola `_meta` yang sudah dipakai untuk `fallbackModel`, `cappedNote`, dst).

### Integrasi ke `index.js` (MCP tool)

Tambahkan parameter baru ke tool `chat_completion` (ikuti pola Zod schema yang sudah ada untuk parameter lain di file itu):

```
allow_lossy_summarization: z.boolean().optional().default(false)
abbreviation_dictionary: z.record(z.string()).optional()
show_token_savings: z.boolean().optional().default(false) — kalau true, tampilkan metadata penghematan di response text
```

Buat juga MCP tool baru `get_token_savings_report` yang menampilkan statistik agregat penghematan token dari sesi berjalan (mirip pola `get_benchmarks` atau `get_reputation` yang sudah ada di file itu — ikuti gaya penulisan tool yang konsisten).

### Integrasi ke `http-server.js`

Tambahkan field yang sama (`allow_lossy_summarization`, `abbreviation_dictionary`) ke body request `POST /v1/chat/completions`, dan sertakan metadata token-saving di field response non-standar `x_token_savings` (pakai prefix `x_` karena ini bukan bagian spec OpenAI resmi, supaya tidak bentrok dengan client yang strict terhadap schema OpenAI).

### Testing & validasi wajib sebelum selesai

1. Jalankan `npm run check` (script yang sudah ada di proyek ini) untuk memastikan semua file baru lolos `node --check`.
2. Tulis contoh test manual di `test-call.js` yang sudah ada (baca dulu isinya untuk ikuti pola yang ada) untuk minimal 3 skenario: (a) context pendek — semua tier 0/1 jalan tanpa mengubah makna, (b) context panjang dengan pesan lama — verifikasi trimming melaporkan metadata dengan benar, (c) abbreviation dictionary — verifikasi ROI check bekerja (skip kalau tidak untung).
3. Update `README.md` dan `ROADMAP.md` untuk mendokumentasikan fitur baru ini mengikuti format yang sudah ada di kedua file itu (bahasa Indonesia untuk ROADMAP.md, ikuti gaya penulisan yang sudah ada).
4. Update `.env.example` dengan semua env var baru yang ditambahkan, ikuti format komentar penjelasan yang sudah ada di file itu.
5. Bump versi di `package.json` sesuai semantic versioning (fitur baru = minor bump).

### Batasan keras — JANGAN LAKUKAN

- JANGAN implementasikan Tier 2/Tier 3 sebagai default aktif — harus selalu opt-in eksplisit.
- JANGAN pernah mengirim singkatan/simbol ke model tanpa definisi eksplisit di system prompt.
- JANGAN silent-drop context tanpa melaporkan di metadata response.
- JANGAN bikin ulang cache/dedup yang sudah ada — pakai `lib/cache.js` dan `lib/dedup.js` yang sudah ada.
- JANGAN gunakan regex untuk minify kode — gunakan parser AST asli (terser untuk JS/TS).
- JANGAN tambahkan dependency berat (hindari framework besar) — proyek ini sengaja zero-dependency selain `@modelcontextprotocol/sdk`, `dotenv`, dan sekarang `terser`/`csso` (pilih yang paling ringan).

Setelah selesai, laporkan ringkasan singkat di akhir: fitur apa saja yang diimplementasikan, file apa saja yang diubah/dibuat, dan estimasi penghematan token rata-rata dari masing-masing tier berdasarkan pengujian manual yang kamu lakukan.

## SELESAI PROMPT