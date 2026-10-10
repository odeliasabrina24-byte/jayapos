/**
 * Code.gs
 *  - doGet(): opens the JayaPOS web app.
 *  - onOpen(): adds the "JayaPOS" menu to the Google Sheet.
 *  - onEdit(): when you type in the Users sheet, turns New_PIN into a safe fingerprint.
 *  - menu...(): actions in the JayaPOS menu. They only work from inside the Sheet.
 */

function doGet() {
  try { autoMigrate_(); } catch (e) { console.error('autoMigrate_: ' + e); }
  let appName = 'JayaPOS';
  try { appName = getSettingsMap_().App_Name || appName; } catch (e) {}
  const t = HtmlService.createTemplateFromFile('Index');
  t.clientVersion = APP_VERSION;      // the phone compares this with the server to spot an old, cached screen
  return t.evaluate()
    .setTitle(appName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);   // lets the JayaPOS home-screen launcher (Netlify) show the app
}

/** Used by Index.html to pull in the other HTML files. */
/** Current version on the server (no login needed). */
function apiVersion() {
  return run_(function () { return { version: APP_VERSION }; });
}

function include(name) {
  const allowed = ['Styles', 'AppJs', 'PosJs', 'TablesJs', 'HistoryJs', 'AdminJs', 'InventoryJs', 'PurchasingJs', 'ReportsJs', 'ShiftJs', 'KitchenJs', 'HomeJs', 'RsvpJs'];
  if (allowed.indexOf(name) < 0) throw new Error('File tidak diizinkan: ' + name);
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('JayaPOS')
    .addItem('1. Setup / perbaiki database', 'menuSetup')
    .addItem('2. Set / reset PIN pengguna', 'menuSetPin')
    .addItem('3. Terapkan perubahan sheet Users', 'menuApplyUsers')
    .addItem('4. Aktifkan pengingat RSVP', 'menuRsvpReminder')
    .addSeparator()
    .addItem('Tampilkan link aplikasi', 'menuShowLink')
    .addToUi();
}

/** Runs by itself whenever someone edits the Sheet. Only reacts to the Users tab. */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    if (e.range.getSheet().getName() !== 'Users') return;
    SS_CACHE_ = e.source;
    processUserSheet_();
  } catch (err) {
    console.error('onEdit Users: ' + err);
  }
}

/** Throws if not run from the Sheet menu (so nobody can trigger these from the web app). */
function sheetUi_() {
  try { return SpreadsheetApp.getUi(); }
  catch (e) { throw new Error('Perintah ini hanya bisa dijalankan dari menu JayaPOS di dalam Google Sheet.'); }
}

function askText_(ui, title, message) {
  const res = ui.prompt(title, message, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return null;
  return res.getResponseText().trim();
}

function menuRsvpReminder() {
  installRsvpReminderTrigger_();
  sheetUi_().alert('Pengingat RSVP aktif. Dicek tiap 5 menit, notif HP dikirim 15 menit sebelum jam RSVP meja khusus.');
}

function menuSetup() {
  const ui = sheetUi_();
  setupDatabase_();
  installRsvpReminderTrigger_();
  const users = getUsers_();
  const hasAdmin = users.some(function (u) { return hasPerm_(u, '*') && u.active && u.hash; });
  let msg = 'Database JayaPOS siap (versi ' + APP_VERSION + ').\n\n';
  if (!hasAdmin) {
    const pin = askText_(ui, 'Buat user ADMIN',
      'Pilih PIN 4–8 angka untuk user admin (username: admin).\nCatat di tempat yang aman.');
    if (!pin) {
      ui.alert('Setup selesai, tapi user admin BELUM dibuat.\nJalankan "1. Setup / perbaiki database" lagi untuk membuatnya.');
      return;
    }
    checkPinFormat_(pin);
    const existing = users.filter(function (u) { return u.username === 'admin'; })[0];
    if (existing) {
      setUserPin_(existing, pin, null);
      updateRow_('Users', existing.row, { Role: 'ADMIN', Active_Status: true });
    } else {
      createUser_({ name: 'Admin', username: 'admin', role: 'ADMIN', pin: pin }, null);
    }
    msg += 'User admin sudah dibuat.\nUsername: admin\nPIN: PIN yang baru Anda pilih.\n\n';
  }
  msg += 'Kalau kodenya diubah, jangan lupa: Deploy > Manage deployments > edit > New version.';
  ui.alert(msg);
}

function menuSetPin() {
  const ui = sheetUi_();
  const username = askText_(ui, 'Set / reset PIN', 'Username pengguna (contoh: admin):');
  if (!username) return;
  const user = getUsers_().filter(function (u) { return u.username === username.toLowerCase(); })[0];
  if (!user) { ui.alert('Tidak ada pengguna dengan username "' + username + '". Cek sheet Users.'); return; }
  const pin = askText_(ui, 'PIN baru untuk ' + user.name, 'Ketik PIN baru 4–8 angka:');
  if (!pin) return;
  checkPinFormat_(pin);
  setUserPin_(user, pin, null);
  ui.alert('PIN untuk ' + user.name + ' sudah diganti.');
}

function menuApplyUsers() {
  const ui = sheetUi_();
  const n = processUserSheet_();
  ui.alert(n ? n + ' baris pengguna diperbarui. Arahkan mouse ke sel yang ada segitiga hitam kecil untuk membaca catatannya.'
             : 'Tidak ada yang perlu diperbarui. Baris yang bermasalah punya catatan di selnya (segitiga hitam kecil).');
}

function menuShowLink() {
  const ui = sheetUi_();
  let url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  ui.alert(url ? 'Link aplikasi JayaPOS:\n\n' + url : 'Aplikasi belum di-deploy. Ikuti Langkah 6 di setup kit.');
}
