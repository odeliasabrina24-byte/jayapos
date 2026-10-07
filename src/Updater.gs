/**
 * Updater.gs
 * Installs a new JayaPOS version without copy-pasting files:
 *  - in the app: ☰ → Pengaturan → "Cek update" → "Update sekarang" (admin, works from a phone), or
 *  - in the Sheet: JayaPOS → 4. Update aplikasi.
 *
 * How it works:
 *  1. A new version is ONE file (update bundle). It is taken from the newest of:
 *     - GitHub: the address in the setting Update_Source (the owner's own repository), and
 *     - Google Drive: files named  JayaPOS-update-<version>.json  in the folder "JayaPOS Updates".
 *  2. The updater shows the version and notes and asks for confirmation.
 *  3. It saves a backup of the current code in the same folder (JayaPOS-backup-<version>-<time>.json),
 *     replaces the code through the Google Apps Script API, makes a new version, and points the web app
 *     link (/exec) at it. The link does not change.
 *  4. New sheets / columns are added automatically the first time the new version opens (autoMigrate_).
 *  "5. Kembalikan ke backup terakhir" puts the previous code back if something goes wrong.
 *
 * One-time requirement: turn ON "Google Apps Script API" at https://script.google.com/home/usersettings
 * (with the same Google account that owns the Sheet).
 *
 * Update file format: { app: 'JayaPOS', version: '3.1.0', notes: '...', mode: 'partial' | 'full',
 *   files: [{ name: 'Pos', type: 'SERVER_JS' | 'HTML' | 'JSON', source: '...' }], remove: ['OldFile'] }
 *   partial = only the listed files change; full = the project becomes exactly the listed files.
 */

const UPDATE_FOLDER_NAME = 'JayaPOS Updates';
const UPDATE_PREFIX = 'JayaPOS-update-';
const BACKUP_PREFIX = 'JayaPOS-backup-';
const MUST_HAVE_FILES = ['appsscript', 'Code', 'Config', 'Updater'];
/** Used when the Settings sheet has no Update_Source row yet (first install of the updater). */
const DEFAULT_UPDATE_SOURCE = 'https://raw.githubusercontent.com/odeliasabrina24-byte/jayapos/main/update.json';

function versionNum_(v) {
  const p = String(v || '0').split('.').map(function (x) { return parseInt(x, 10) || 0; });
  return (p[0] || 0) * 1000000 + (p[1] || 0) * 1000 + (p[2] || 0);
}

function updateFolder_(create) {
  const it = DriveApp.getFoldersByName(UPDATE_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return create ? DriveApp.createFolder(UPDATE_FOLDER_NAME) : null;
}

/** Reads every update (or backup) file in the folder. Returns [{ file, name, bundle }], newest version first. */
function listBundles_(prefix) {
  const folder = updateFolder_(false);
  if (!folder) return [];
  const out = [];
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const name = f.getName();
    if (name.indexOf(prefix) !== 0 || !/\.json$/i.test(name) || f.isTrashed()) continue;
    let bundle = null;
    try { bundle = JSON.parse(f.getBlob().getDataAsString('UTF-8')); } catch (e) { continue; }
    if (!bundle || bundle.app !== 'JayaPOS' || !Array.isArray(bundle.files)) continue;
    out.push({ file: f, name: name, bundle: bundle, time: f.getDateCreated().getTime() });
  }
  out.sort(function (a, b) { return versionNum_(b.bundle.version) - versionNum_(a.bundle.version) || b.time - a.time; });
  return out;
}

function checkBundle_(b) {
  if (!b || b.app !== 'JayaPOS' || !Array.isArray(b.files) || !/^\d+\.\d+\.\d+$/.test(String(b.version || ''))) {
    throw new Error('File update tidak valid.');
  }
  return b;
}

/** The update bundle on GitHub (Update_Source), or null when not set / not reachable. */
function githubBundle_() {
  const set = getSettingsMap_().Update_Source;
  const url = String(set === undefined ? DEFAULT_UPDATE_SOURCE : set || '').trim();
  if (!url) return null;
  if (!/^https:\/\/raw\.githubusercontent\.com\//.test(url)) throw new Error('Sumber update harus alamat raw.githubusercontent.com.');
  const res = UrlFetchApp.fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) throw new Error('GitHub tidak bisa dibuka (' + res.getResponseCode() + ').');
  return checkBundle_(JSON.parse(res.getContentText('UTF-8')));
}

/** Newest update from GitHub or the Drive folder: { bundle, source } or null. */
function latestUpdate_() {
  const found = [];
  let ghError = '';
  try { const g = githubBundle_(); if (g) found.push({ bundle: g, source: 'GitHub' }); }
  catch (e) { ghError = String(e && e.message || e); }
  try { const d = listBundles_(UPDATE_PREFIX)[0]; if (d) found.push({ bundle: d.bundle, source: 'Drive: ' + d.name }); }
  catch (e) { /* no Drive folder */ }
  found.sort(function (a, b) { return versionNum_(b.bundle.version) - versionNum_(a.bundle.version); });
  if (!found.length && ghError) throw new Error(ghError);
  return found[0] || null;
}

/** Runs the database setup once after a new version is installed (new sheets, columns, settings). */
function autoMigrate_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === APP_VERSION) return false;
  if (!props.getProperty('SPREADSHEET_ID')) return false;    // never set up: the owner runs Setup from the Sheet
  return withLock_(function () {
    if (props.getProperty('SCHEMA_VERSION') === APP_VERSION) return false;
    setupDatabase_();
    return true;
  });
}

/** Calls the Apps Script API with the owner's login. */
function scriptApi_(method, path, body) {
  const res = UrlFetchApp.fetch('https://script.googleapis.com/v1/projects/' + ScriptApp.getScriptId() + path, {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};
  let msg = text;
  try { msg = JSON.parse(text).error.message; } catch (e) { /* not JSON */ }
  if (/Apps Script API|has not been used|is disabled|not enabled/i.test(msg)) {
    throw new Error('Google Apps Script API belum dinyalakan. Buka https://script.google.com/home/usersettings , ' +
                    'nyalakan "Google Apps Script API", tunggu 1 menit, lalu coba lagi.');
  }
  throw new Error('Google menolak (' + code + '): ' + msg);
}

function checkBundleFiles_(files) {
  files.forEach(function (f) {
    if (!/^[A-Za-z0-9_]{1,60}$/.test(String(f.name || ''))) throw new Error('Nama file tidak valid di update: ' + f.name);
    if (['SERVER_JS', 'HTML', 'JSON'].indexOf(f.type) < 0) throw new Error('Jenis file tidak valid: ' + f.name);
    if (typeof f.source !== 'string' || !f.source.length) throw new Error('File kosong di update: ' + f.name);
    if (f.type === 'JSON' && f.name !== 'appsscript') throw new Error('Hanya appsscript boleh berjenis JSON.');
  });
}

/** Merges the update into the current files and checks the result can still update itself. */
function mergeFiles_(current, bundle) {
  checkBundleFiles_(bundle.files);
  let out = bundle.mode === 'full' ? [] : current.map(function (f) { return { name: f.name, type: f.type, source: f.source }; });
  const remove = Array.isArray(bundle.remove) ? bundle.remove.map(String) : [];
  out = out.filter(function (f) { return remove.indexOf(f.name) < 0 || MUST_HAVE_FILES.indexOf(f.name) >= 0; });
  bundle.files.forEach(function (nf) {
    const i = out.map(function (f) { return f.name; }).indexOf(nf.name);
    const copy = { name: nf.name, type: nf.type, source: nf.source };
    if (i >= 0) out[i] = copy; else out.push(copy);
  });
  MUST_HAVE_FILES.forEach(function (n) {
    if (!out.some(function (f) { return f.name === n; })) throw new Error('Update ini tidak lengkap (tidak ada ' + n + '). Tidak dipasang.');
  });
  const manifest = out.filter(function (f) { return f.name === 'appsscript'; })[0];
  let m;
  try { m = JSON.parse(manifest.source); } catch (e) { throw new Error('appsscript.json di update rusak. Tidak dipasang.'); }
  const scopes = m.oauthScopes || [];
  if (scopes.indexOf('https://www.googleapis.com/auth/script.projects') < 0 || scopes.indexOf('https://www.googleapis.com/auth/script.deployments') < 0) {
    throw new Error('appsscript.json di update tidak mengizinkan update otomatis berikutnya. Tidak dipasang.');
  }
  return out;
}

/** Installs a bundle. Returns a short summary. */
function applyBundle_(bundle, isRollback) {
  const current = scriptApi_('get', '/content').files || [];
  const files = mergeFiles_(current, bundle);
  const stamp = fmt_(new Date(), 'yyyyMMdd-HHmm');
  // backup first, so it can always be undone
  const backup = { app: 'JayaPOS', version: APP_VERSION, notes: 'Backup otomatis sebelum ' + (isRollback ? 'rollback' : 'update ke ' + bundle.version),
                   mode: 'full', files: current.map(function (f) { return { name: f.name, type: f.type, source: f.source }; }) };
  updateFolder_(true).createFile(BACKUP_PREFIX + APP_VERSION + '-' + stamp + '.json', JSON.stringify(backup), 'application/json');

  scriptApi_('put', '/content', { files: files });
  const ver = scriptApi_('post', '/versions', { description: 'JayaPOS ' + bundle.version + (isRollback ? ' (rollback)' : '') });
  const deps = (scriptApi_('get', '/deployments').deployments || []).filter(function (d) {
    const web = (d.entryPoints || []).some(function (e) { return e.entryPointType === 'WEB_APP'; });
    return web && d.deploymentConfig && d.deploymentConfig.versionNumber;   // skip the editor's "HEAD" test deployment
  });
  deps.forEach(function (d) {
    scriptApi_('put', '/deployments/' + d.deploymentId, { deploymentConfig: {
      scriptId: ScriptApp.getScriptId(), versionNumber: ver.versionNumber, manifestFileName: 'appsscript',
      description: 'JayaPOS ' + bundle.version } });
  });
  try { audit_(null, isRollback ? 'APP_ROLLBACK' : 'APP_UPDATE', 'System', String(bundle.version), { from: APP_VERSION, files: bundle.files.length, deployments: deps.length, version: ver.versionNumber }); }
  catch (e) { /* audit is optional */ }
  return { version: bundle.version, files: bundle.files.length, deployments: deps.length, versionNumber: ver.versionNumber };
}

function updateResultText_(r) {
  return 'JayaPOS ' + r.version + ' terpasang (' + r.files + ' file, versi Apps Script #' + r.versionNumber + ').\n' +
    (r.deployments ? 'Link aplikasi sudah diarahkan ke versi baru (link tetap sama).\n'
                   : 'PERHATIAN: tidak ada deployment web app yang ditemukan. Buat lewat Deploy → New deployment.\n') +
    '\nSheet baru / kolom baru dibuat otomatis saat JayaPOS dibuka pertama kali.\n' +
    'Di setiap HP, tutup JayaPOS lalu buka lagi.';
}

/** Menu: JayaPOS → 4. Update aplikasi */
function menuUpdate() {
  const ui = sheetUi_();
  try {
    const u = latestUpdate_();
    if (!u) {
      updateFolder_(true);
      ui.alert('Update aplikasi', 'Belum ada versi baru di GitHub maupun di folder Drive "' + UPDATE_FOLDER_NAME + '".', ui.ButtonSet.OK);
      return;
    }
    u.name = u.source;
    const same = versionNum_(u.bundle.version) <= versionNum_(APP_VERSION);
    const ok = ui.alert('Update JayaPOS',
      'Versi sekarang: ' + APP_VERSION + '\nVersi di file: ' + u.bundle.version + ' (' + u.name + ')\n\n' +
      (u.bundle.notes ? String(u.bundle.notes).slice(0, 600) + '\n\n' : '') +
      (same ? 'Versi ini TIDAK lebih baru. Pasang ulang?' : 'Pasang sekarang? Kode lama disimpan sebagai backup.') +
      '\nJangan dipakai saat kasir sedang menerima pembayaran.', ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return;
    ui.alert('Update selesai', updateResultText_(applyBundle_(u.bundle, false)), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Update gagal', String(e && e.message || e) + '\n\nTidak ada yang berubah kecuali disebutkan di atas.', ui.ButtonSet.OK);
  }
}

/** Menu: JayaPOS → 5. Kembalikan ke backup terakhir */
function menuRollback() {
  const ui = sheetUi_();
  try {
    const list = listBundles_(BACKUP_PREFIX).sort(function (a, b) { return b.time - a.time; });
    if (!list.length) { ui.alert('Belum ada backup.'); return; }
    const b = list[0];
    const ok = ui.alert('Kembalikan versi sebelumnya', 'Pasang kembali ' + b.name + ' (JayaPOS ' + b.bundle.version + ')?', ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return;
    ui.alert('Selesai', updateResultText_(applyBundle_(b.bundle, true)), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Gagal', String(e && e.message || e), ui.ButtonSet.OK);
  }
}

/**
 * For the FIRST install (or when the Sheet menu is not available): in the Apps Script editor choose
 * jalankanUpdate in the function list and press Run. Progress is shown in the Execution log.
 */
function jalankanUpdate() {
  const u = latestUpdate_();
  if (!u) throw new Error('Tidak ada update di GitHub maupun di folder Drive "' + UPDATE_FOLDER_NAME + '".');
  console.log('Memasang JayaPOS ' + u.bundle.version + ' dari ' + u.source + ' …');
  console.log(updateResultText_(applyBundle_(u.bundle, false)));
}

// ---------------- In the app (admin, also from a phone) ----------------

function apiCheckUpdate(token) {
  return run_(function () {
    requirePerm_(token, 'settings.manage');
    const u = latestUpdate_();
    return {
      current: APP_VERSION,
      latest: u ? u.bundle.version : null,
      notes: u ? String(u.bundle.notes || '').slice(0, 1500) : '',
      source: u ? u.source : '',
      newer: !!u && versionNum_(u.bundle.version) > versionNum_(APP_VERSION),
      backups: (function () { try { return listBundles_(BACKUP_PREFIX).length; } catch (e) { return 0; } })()
    };
  });
}

function apiInstallUpdate(token, version) {
  return run_(function () {
    const user = requirePerm_(token, 'settings.manage');
    return withLock_(function () {
      const u = latestUpdate_();
      if (!u || u.bundle.version !== String(version)) throw new Error('Versi update berubah. Tekan "Cek update" lagi.');
      const r = applyBundle_(u.bundle, false);
      audit_(user, 'APP_UPDATE_FROM_APP', 'System', r.version, { source: u.source });
      return r;
    });
  });
}

function apiRollbackUpdate(token) {
  return run_(function () {
    const user = requirePerm_(token, 'settings.manage');
    return withLock_(function () {
      const list = listBundles_(BACKUP_PREFIX).sort(function (a, b) { return b.time - a.time; });
      if (!list.length) throw new Error('Belum ada backup.');
      const r = applyBundle_(list[0].bundle, true);
      PropertiesService.getScriptProperties().deleteProperty('SCHEMA_VERSION');
      audit_(user, 'APP_ROLLBACK_FROM_APP', 'System', r.version, { backup: list[0].name });
      return r;
    });
  });
}
