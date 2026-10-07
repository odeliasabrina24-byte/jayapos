/**
 * Auth.gs
 * Login with username + PIN, sessions, permission checks, audit log,
 * and adding users / PINs straight from the Users sheet.
 *
 * How it works:
 *  - PINs are never kept. Only a salted SHA-256 "fingerprint" (PIN_Hash) is saved.
 *  - In the Users sheet you may type a PIN in the New_PIN column. JayaPOS turns it
 *    into a fingerprint right away and clears the cell.
 *  - After login the phone gets a random session token. Every server call sends it.
 *  - Every server call re-reads the user from the Users sheet, so deactivating
 *    a user or changing their role takes effect immediately.
 *  - Permissions are checked HERE on the server, not only by hiding buttons.
 *
 * Functions whose names end with "_" cannot be called from the browser
 * (Apps Script rule). Browser-callable functions all start with "api".
 */

function run_(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, error: (e && e.message) ? e.message : String(e), code: (e && e.jayaCode) || '' };
  }
}

function jayaError_(message, code) {
  const e = new Error(message);
  e.jayaCode = code;
  return e;
}

// ---------------- PIN hashing ----------------

function bytesToHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function hashPin_(pin, salt) {
  let h = salt + ':' + pin;
  for (let i = 0; i < 100; i++) {
    h = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + ':' + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function newSalt_() { return Utilities.getUuid().replace(/-/g, ''); }

function checkPinFormat_(pin) {
  if (!/^\d{4,8}$/.test(String(pin == null ? '' : pin))) throw new Error('PIN harus 4 sampai 8 angka.');
}

// ---------------- Users ----------------

function getUsers_() {
  let rows = readTable_('Users').rows;
  const pending = rows.some(function (r) {
    return String(r.New_PIN == null ? '' : r.New_PIN).trim() !== '' ||
           (!String(r.User_ID || '').trim() && String(r.Username || '').trim() !== '');
  });
  if (pending) {           // someone typed in the Users sheet and the edit trigger did not run
    processUserSheet_();
    rows = readTable_('Users').rows;
  }
  return rows.map(function (r) {
    return {
      row: r._row,
      id: String(r.User_ID).trim(),
      name: String(r.Full_Name).trim(),
      username: String(r.Username).trim().toLowerCase(),
      role: String(r.Role).trim().toUpperCase(),
      hash: String(r.PIN_Hash || '').trim(),
      salt: String(r.PIN_Salt || '').trim(),
      active: isTrue_(r.Active_Status)
    };
  }).filter(function (u) { return u.id && u.username; });
}

function setUserPin_(user, pin, actor) {
  checkPinFormat_(pin);
  const salt = newSalt_();
  updateRow_('Users', user.row, { PIN_Hash: hashPin_(String(pin), salt), PIN_Salt: salt, Updated_At: nowStamp_() });
  CacheService.getScriptCache().remove('fail_' + user.username);
  audit_(actor, 'USER_PIN_RESET', 'User', user.id, { username: user.username });
}

/**
 * Tidies the Users sheet after someone types in it:
 *  - new row with a Username gets a User_ID, Role CASHIER and Active TRUE if left empty
 *  - a PIN typed in New_PIN becomes PIN_Hash/PIN_Salt and the cell is cleared
 *  - problems are shown as a note on the cell (hover to read)
 */
function processUserSheet_() {
  const t = readTable_('Users');
  const sh = t.sheet;
  const H = t.headers;
  if (H.indexOf('New_PIN') < 0) return 0;
  const ids = t.rows.map(function (r) { return String(r.User_ID || '').trim(); }).filter(String);
  const usernames = {};
  t.rows.forEach(function (r) {
    const u = String(r.Username || '').trim().toLowerCase();
    if (u) usernames[u] = (usernames[u] || 0) + 1;
  });
  let changed = 0;

  t.rows.forEach(function (r) {
    const fields = {};
    const note = function (header, msg) { sh.getRange(r._row, H.indexOf(header) + 1).setNote(msg); };
    let id = String(r.User_ID || '').trim();
    const rawName = String(r.Username || '').trim();
    const uname = rawName.toLowerCase();
    const pin = String(r.New_PIN == null ? '' : r.New_PIN).trim();
    const nameOk = /^[a-z0-9._-]{3,30}$/.test(uname);

    if (rawName && rawName !== uname && nameOk) fields.Username = uname;
    const role = String(r.Role || '').trim().toUpperCase();
    if (role && role !== String(r.Role)) fields.Role = role;
    if (role && ROLES.indexOf(role) < 0) note('Role', 'Role tidak dikenal. Pilih salah satu: ' + ROLES.join(', '));

    if (!id && uname) {
      if (!nameOk) {
        note('Username', 'Username harus 3–30 karakter: huruf, angka, titik atau strip. Tanpa spasi.');
      } else if (usernames[uname] > 1) {
        note('Username', 'Username ini sudah dipakai di baris lain.');
      } else {
        id = nextId_(ids, 'U', 3);
        ids.push(id);
        fields.User_ID = id;
        fields.Created_At = nowStamp_();
        if (!role) fields.Role = 'CASHIER';
        if (String(r.Active_Status == null ? '' : r.Active_Status).trim() === '') fields.Active_Status = true;
        if (!String(r.Full_Name || '').trim()) fields.Full_Name = rawName;
        sh.getRange(r._row, H.indexOf('Username') + 1).clearNote();
      }
    }

    if (pin) {
      fields.New_PIN = '';                     // never leave a typed PIN in the sheet
      if (!id) {
        note('New_PIN', 'PIN tidak tersimpan: isi Username yang benar dulu, lalu ketik PIN lagi.');
      } else if (!/^\d{4,8}$/.test(pin)) {
        note('New_PIN', 'PIN tidak tersimpan: harus 4 sampai 8 angka. Ketik lagi.');
      } else {
        const salt = newSalt_();
        fields.PIN_Hash = hashPin_(pin, salt);
        fields.PIN_Salt = salt;
        fields.Updated_At = nowStamp_();
        note('New_PIN', 'PIN diset ' + nowStamp_() + '. Ketik di sini lagi kapan saja untuk menggantinya.');
        CacheService.getScriptCache().remove('fail_' + uname);
        audit_(null, 'USER_PIN_SET_IN_SHEET', 'User', id, { username: uname });
      }
    }

    if (Object.keys(fields).length) {
      updateRow_('Users', r._row, fields);
      changed++;
    }
  });
  return changed;
}

// ---------------- Permissions ----------------

function hasPerm_(role, perm) {
  const list = ROLE_PERMISSIONS[role] || [];
  return list.indexOf('*') >= 0 || list.indexOf(perm) >= 0;
}
function hasAnyPerm_(role, perms) {
  return perms.some(function (p) { return hasPerm_(role, p); });
}

function navFor_(role) {
  return NAV.filter(function (n) { return hasAnyPerm_(role, n.perms); })
    .map(function (n) { return { id: n.id, label: n.label, section: n.section || '', ready: n.ready, phase: n.phase || null, about: n.about || '' }; });
}

function requireSession_(token) {
  if (!token || typeof token !== 'string' || token.length > 100) throw jayaError_('Silakan login.', 'AUTH');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) throw jayaError_('Sesi Anda sudah habis. Silakan login lagi.', 'AUTH');
  const s = JSON.parse(raw);
  const user = getUsers_().filter(function (u) { return u.id === s.u; })[0];
  if (!user || !user.active || ROLES.indexOf(user.role) < 0) {
    cache.remove('sess_' + token);
    throw jayaError_('Akun Anda tidak aktif. Hubungi admin.', 'AUTH');
  }
  cache.put('sess_' + token, raw, SESSION_SECONDS); // keep session alive while in use
  return user;
}

/** Throws unless the logged-in user has at least one of the permissions. */
function requirePerm_(token, perms) {
  const user = requireSession_(token);
  const list = Array.isArray(perms) ? perms : [perms];
  if (!hasAnyPerm_(user.role, list)) {
    throw jayaError_('Akses ditolak. Role Anda (' + (ROLE_LABELS[user.role] || user.role) + ') tidak boleh melakukan ini.', 'DENIED');
  }
  return user;
}

function sessionPayload_(user, token) {
  return {
    token: token,
    user: { id: user.id, name: user.name, username: user.username, role: user.role },
    permissions: ROLE_PERMISSIONS[user.role] || [],
    nav: navFor_(user.role),
    settings: getSettingsMap_(),
    paymentMethods: PAYMENT_METHODS,
    paymentOrder: PAYMENT_ORDER,
    roleLabels: ROLE_LABELS,
    unreadNotifications: hasPerm_(user.role, 'notifications.view') ? safeUnread_() : 0,
    version: APP_VERSION
  };
}

function safeUnread_() {
  try { return notifUnreadCount_(); } catch (e) { return 0; }
}

// ---------------- Audit log ----------------

function audit_(user, action, recordType, recordId, details) {
  try {
    appendObjects_('Audit_Log', [{
      Timestamp: nowStamp_(),
      User_ID: user ? user.id : 'SYSTEM',
      Username: user ? user.username : 'system',
      Action: action,
      Record_Type: recordType || '',
      Record_ID: recordId || '',
      Details: typeof details === 'string' ? details : JSON.stringify(details || {})
    }]);
  } catch (e) {
    console.error('Audit log failed: ' + e);
  }
}

// ---------------- Browser-callable ----------------

function apiGetLoginUsers() {
  return run_(function () {
    const s = getSettingsMap_();
    const users = getUsers_()
      .filter(function (u) { return u.active && u.hash; })
      .map(function (u) { return { username: u.username, name: u.name }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    return { users: users, businessName: s.Business_Name, appName: s.App_Name };
  });
}

function apiLogin(username, pin) {
  return run_(function () {
    const uname = String(username || '').trim().toLowerCase().slice(0, 40);
    const cache = CacheService.getScriptCache();
    const failKey = 'fail_' + uname;
    const fails = Number(cache.get(failKey) || 0);
    if (fails >= MAX_PIN_FAILS) throw new Error('Terlalu banyak PIN salah. Tunggu 5 menit lalu coba lagi.');

    const user = getUsers_().filter(function (u) { return u.username === uname; })[0];
    const ok = user && user.active && user.hash && /^\d{4,8}$/.test(String(pin || '')) &&
               hashPin_(String(pin), user.salt) === user.hash;
    if (!ok) {
      cache.put(failKey, String(fails + 1), PIN_LOCK_SECONDS);
      audit_(null, 'LOGIN_FAILED', 'User', user ? user.id : '', { username: uname });
      throw new Error('Username atau PIN salah.');
    }
    cache.remove(failKey);
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    cache.put('sess_' + token, JSON.stringify({ u: user.id, t: Date.now() }), SESSION_SECONDS);
    audit_(user, 'LOGIN', 'User', user.id, '');
    return sessionPayload_(user, token);
  });
}

function apiResume(token) {
  return run_(function () { return sessionPayload_(requireSession_(token), token); });
}

function apiLogout(token) {
  return run_(function () {
    if (token && typeof token === 'string' && token.length <= 100) CacheService.getScriptCache().remove('sess_' + token);
    return true;
  });
}
