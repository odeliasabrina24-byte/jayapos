# JayaPOS

POS untuk Babi Kopi Jaya Bali — Google Sheets + Google Apps Script.

- `src/` — semua file Apps Script (sama persis dengan yang ada di editor Apps Script).
- `update.json` — paket update. JayaPOS mengambil file ini saat admin menekan
  **☰ → Pengaturan → Cek update → Update sekarang**.
- `tools/build_update.py` — membuat `update.json` dari `src/`.

Repo ini hanya berisi kode aplikasi. Data penjualan, pengguna, PIN dan pengaturan
tersimpan di Google Sheet milik pemilik usaha, tidak di sini.

**Penting:** siapa pun yang bisa mengubah repo ini bisa mengubah aplikasi kasir.
Jangan beri akses tulis ke orang lain.
