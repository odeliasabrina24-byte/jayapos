# JayaPOS

POS untuk Babi Kopi Jaya Bali — Google Sheets + Google Apps Script.

- `src/` — semua file Apps Script (sama persis dengan yang ada di editor Apps Script).
- `.github/workflows/deploy.yml` — setiap perubahan di `src/` otomatis dipasang ke
  Apps Script JayaPOS dan di-deploy (link /exec tetap sama). Butuh secrets
  `CLASPRC_JSON`, `SCRIPT_ID`, `DEPLOYMENT_ID`.

Repo ini hanya berisi kode aplikasi. Data penjualan, pengguna, PIN dan pengaturan
tersimpan di Google Sheet milik pemilik usaha, tidak di sini.

**Penting:** siapa pun yang bisa mengubah repo ini bisa mengubah aplikasi kasir.
Jangan beri akses tulis ke orang lain.
