/**
 * Database.gs
 * Reading and writing the Google Sheet. Other files use only these helpers.
 * Columns are found by their HEADER NAME, so you may reorder columns safely
 * (but do not rename headers).
 */

let SS_CACHE_ = null;
let SETTINGS_CACHE_ = null;

function getSpreadsheet_() {
  if (SS_CACHE_) return SS_CACHE_;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  SS_CACHE_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!SS_CACHE_) {
    throw new Error('JayaPOS tidak menemukan Google Sheet-nya. Buka Sheet lalu jalankan JayaPOS > 1. Setup / perbaiki database.');
  }
  return SS_CACHE_;
}

function getSheet_(name) {
  const sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) {
    throw new Error('Sheet "' + name + '" tidak ada. Buka Google Sheet lalu jalankan JayaPOS > 1. Setup / perbaiki database.');
  }
  return sh;
}

function getHeaders_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return [];
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

/** Reads a whole sheet into objects keyed by header. Each object has _row (sheet row number). */
function readTable_(name) {
  const sh = getSheet_(name);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { sheet: sh, headers: [], rows: [] };
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r.every(function (v) { return v === '' || v === null; })) continue;
    const o = { _row: i + 1 };
    headers.forEach(function (h, j) { if (h) o[h] = r[j]; });
    rows.push(o);
  }
  return { sheet: sh, headers: headers, rows: rows };
}

function rowObject_(sh, headers, rowNum) {
  const vals = sh.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  const o = { _row: rowNum };
  headers.forEach(function (h, j) { if (h) o[h] = vals[j]; });
  return o;
}

/** Fast exact-match search in one column. Returns sheet row numbers. */
function findRowNumbers_(sh, headers, header, value) {
  const c = headers.indexOf(header);
  const lastRow = sh.getLastRow();
  if (c < 0 || lastRow < 2) return [];
  return sh.getRange(2, c + 1, lastRow - 1, 1)
    .createTextFinder(String(value))
    .matchEntireCell(true)
    .matchCase(true)
    .findAll()
    .map(function (r) { return r.getRow(); });
}

/** Appends rows (objects keyed by header) in ONE write, with correct number formats. */
function appendObjects_(name, objects) {
  if (!objects || !objects.length) return;
  const sh = getSheet_(name);
  const headers = getHeaders_(sh);
  const schema = SCHEMA[name] || {};
  const textCols = schema.text || [];
  const moneyCols = schema.money || [];
  const rows = objects.map(function (o) {
    return headers.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; });
  });
  const formats = objects.map(function () {
    return headers.map(function (h) {
      if (textCols.indexOf(h) >= 0) return '@';
      if (moneyCols.indexOf(h) >= 0) return '#,##0';
      return 'General';
    });
  });
  const start = sh.getLastRow() + 1;
  const needed = start + rows.length - 1;
  if (needed > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows() + 200);
  const range = sh.getRange(start, 1, rows.length, headers.length);
  range.setNumberFormats(formats);
  range.setValues(rows);
}

/** Updates some cells of one row in a single write. fields = { Header: value } */
function updateRow_(name, rowNum, fields) {
  const sh = getSheet_(name);
  const headers = getHeaders_(sh);
  const textCols = (SCHEMA[name] || {}).text || [];
  const range = sh.getRange(rowNum, 1, 1, headers.length);
  const values = range.getValues()[0];
  const formats = range.getNumberFormats()[0];
  Object.keys(fields).forEach(function (k) {
    const c = headers.indexOf(k);
    if (c < 0) throw new Error('Kolom "' + k + '" tidak ada di sheet ' + name + '. Jalankan JayaPOS > 1. Setup / perbaiki database.');
    values[c] = fields[k];
    if (textCols.indexOf(k) >= 0) formats[c] = '@';
  });
  range.setNumberFormats([formats]);
  range.setValues([values]);
}

function getSettingsMap_() {
  if (SETTINGS_CACHE_) return SETTINGS_CACHE_;
  const map = {};
  SETTINGS_DEFAULTS.forEach(function (d) { map[d[0]] = d[1]; });
  try {
    readTable_('Settings').rows.forEach(function (r) {
      const k = String(r.Setting).trim();
      if (k) map[k] = cellText_(r.Value);
    });
  } catch (e) { /* Settings sheet missing: use defaults */ }
  SETTINGS_CACHE_ = map;
  return map;
}

/** Runs fn while holding the script lock, so two phones cannot write at the same moment. */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Sistem sedang sibuk. Tunggu beberapa detik lalu coba lagi.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------- Small value helpers ----------------

function tz_() { return Session.getScriptTimeZone() || 'Asia/Makassar'; }
function fmt_(d, pattern) { return Utilities.formatDate(d, tz_(), pattern); }
function todayStr_() { return fmt_(new Date(), 'yyyy-MM-dd'); }
function nowStamp_() { return fmt_(new Date(), 'yyyy-MM-dd HH:mm:ss'); }

function cellText_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmt_(v, 'yyyy-MM-dd HH:mm:ss');
  return String(v).trim();
}
function dateText_(v) {
  if (v instanceof Date) return fmt_(v, 'yyyy-MM-dd');
  return String(v == null ? '' : v).trim().slice(0, 10);
}
function timeText_(v) {
  if (v instanceof Date) return fmt_(v, 'HH:mm');
  return String(v == null ? '' : v).trim().slice(0, 5);
}
/** Rupiah amounts are whole numbers. Returns NaN for an empty cell. */
function moneyNum_(v) {
  if (typeof v === 'number') return Math.round(v);
  const s = String(v == null ? '' : v).replace(/[^0-9-]/g, '');
  return (s === '' || s === '-') ? NaN : parseInt(s, 10);
}
/** Plain number (decimals allowed), with a default. */
function numOr_(v, d) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return isFinite(n) ? n : d;
}
function isTrue_(v) {
  return v === true || /^(true|yes|ya|y|1|active|aktif)$/i.test(String(v == null ? '' : v).trim());
}
/** Cleans user-typed text: one line, length limit, cannot start a formula. */
function cleanText_(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().replace(/^[=+@]+/, '').trim().slice(0, max || 100);
}
function nextId_(ids, prefix, pad) {
  let max = 0;
  ids.forEach(function (id) {
    const m = String(id).match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + String(max + 1).padStart(pad, '0');
}
function isDateStr_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function addDays_(ds, n) {
  const p = ds.split('-').map(Number);
  return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)), 'UTC', 'yyyy-MM-dd');
}
function dayOfWeek_(ds) { // 0 = Sunday
  const p = ds.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}
function dateLabel_(ds) {
  if (!isDateStr_(ds)) return ds || '';
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const p = ds.split('-');
  return p[2] + ' ' + m[parseInt(p[1], 10) - 1] + ' ' + p[0];
}
function listSetting_(key) {
  return String(getSettingsMap_()[key] || '').split(',').map(function (c) { return c.trim(); }).filter(String);
}

/** For recipes/inventory later: convert qty between units with the same base (kg->g ok, g->ml refused). */
function convertQty_(qty, fromUnit, toUnit) {
  const a = UNITS[String(fromUnit).toLowerCase()];
  const b = UNITS[String(toUnit).toLowerCase()];
  if (!a || !b) throw new Error('Satuan tidak dikenal: ' + (!a ? fromUnit : toUnit));
  if (a.base !== b.base) throw new Error('Tidak bisa mengubah ' + fromUnit + ' ke ' + toUnit + '.');
  return qty * a.factor / b.factor;
}

// ---------------- Setup ----------------

/** Creates / repairs all sheets. Safe to run again: it never deletes your data. */
function setupDatabase_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet() || getSpreadsheet_();   // no active Sheet when called from the web app
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  SS_CACHE_ = ss;
  SETTINGS_CACHE_ = null;
  ss.setSpreadsheetTimeZone(tz_());

  Object.keys(SCHEMA).forEach(function (name) { ensureSheet_(ss, name, SCHEMA[name]); });

  const settingRows = readTable_('Settings').rows;
  const existing = settingRows.map(function (r) { return String(r.Setting).trim(); });
  const descUpd = {};   // keep the Description column up to date (it is only an explanation)
  settingRows.forEach(function (r) {
    const d = SETTINGS_DEFAULTS.filter(function (x) { return x[0] === String(r.Setting).trim(); })[0];
    if (d && String(r.Description) !== d[2]) descUpd[r._row] = d[2];
  });
  setColumnValues_('Settings', 'Description', descUpd);
  appendObjects_('Settings', SETTINGS_DEFAULTS
    .filter(function (d) { return existing.indexOf(d[0]) < 0; })
    .map(function (d) { return { Setting: d[0], Value: d[1], Description: d[2] }; }));
  SETTINGS_CACHE_ = null;

  if (readTable_('Products').rows.length === 0) {
    appendObjects_('Products', SAMPLE_PRODUCTS.map(function (p) {
      return { Product_ID: p[0], Product_Name: p[1], Category: p[2], Selling_Price: p[3], Cost: p[4],
               Active: true, Recipe_Group: p[5], Updated_At: nowStamp_(), Image_URL: '' };
    }));
  }

  if (readTable_('Tables').rows.length === 0) {
    appendObjects_('Tables', SAMPLE_TABLES.map(function (t) {
      return { Table_ID: t[0], Table_Name: t[1], Area: t[2], Seats: t[3], Shape: t[4], Pos_X: t[5], Pos_Y: t[6],
               Width: t[7], Height: t[8], Active: true, Updated_At: nowStamp_() };
    }));
  }

  ['Sheet1', 'Lembar1', 'Sheet 1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0 && s.getLastColumn() === 0) ss.deleteSheet(s);
  });

  audit_(null, 'SETUP', 'System', '', 'Database setup / repair, version ' + APP_VERSION);
  PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION', APP_VERSION);
}

function ensureSheet_(ss, name, schema) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  let headers = getHeaders_(sh);
  if (!headers.length || headers.every(function (h) { return !h; })) {
    sh.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]);
  } else {
    schema.headers.forEach(function (h) {
      if (headers.indexOf(h) < 0) {
        sh.getRange(1, sh.getLastColumn() + 1).setValue(h);
        headers = getHeaders_(sh);
      }
    });
  }
  headers = getHeaders_(sh);
  const maxRows = sh.getMaxRows();
  (schema.text || []).forEach(function (h) {
    const c = headers.indexOf(h);
    if (c >= 0) sh.getRange(1, c + 1, maxRows, 1).setNumberFormat('@');
  });
  (schema.money || []).forEach(function (h) {
    const c = headers.indexOf(h);
    if (c >= 0 && maxRows > 1) sh.getRange(2, c + 1, maxRows - 1, 1).setNumberFormat('#,##0');
  });
  Object.keys(schema.lists || {}).forEach(function (h) {
    const c = headers.indexOf(h);
    if (c < 0 || maxRows < 2) return;
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(schema.lists[h], true)
      .setAllowInvalid(true)
      .build();
    sh.getRange(2, c + 1, maxRows - 1, 1).setDataValidation(rule);
  });
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground(schema.planned ? '#9e9e9e' : '#3b2a20')
    .setFontColor('#ffffff');
  sh.setFrozenRows(1);
  if (schema.planned) sh.setTabColor('#9e9e9e');
  else if (['Ingredients', 'Recipes', 'Recipe_Details', 'Suppliers', 'Purchase_Orders', 'Purchase_Order_Details',
            'Inventory_Movements'].indexOf(name) >= 0) sh.setTabColor(null);   // v1 showed these as "planned" (grey)
}

/** Deletes every row whose column `header` equals value. Rows are removed bottom-up in blocks. */
function deleteRowsWhere_(name, header, value) {
  const sh = getSheet_(name);
  const rows = findRowNumbers_(sh, getHeaders_(sh), header, value).sort(function (a, b) { return b - a; });
  let i = 0;
  while (i < rows.length) {
    let end = rows[i];
    let start = end;
    while (i + 1 < rows.length && rows[i + 1] === start - 1) { i++; start = rows[i]; }
    sh.deleteRows(start, end - start + 1);
    i++;
  }
  return rows.length;
}

/** Writes one whole column (rows 2..n+1) in a single call. values = array in sheet row order. */
function writeColumn_(name, header, values) {
  if (!values.length) return;
  const sh = getSheet_(name);
  const c = getHeaders_(sh).indexOf(header);
  if (c < 0) throw new Error('Kolom "' + header + '" tidak ada di sheet ' + name + '. Jalankan JayaPOS > 1. Setup / perbaiki database.');
  sh.getRange(2, c + 1, values.length, 1).setValues(values.map(function (v) { return [v]; }));
}

function round4_(n) { return Math.round(n * 10000) / 10000; }
