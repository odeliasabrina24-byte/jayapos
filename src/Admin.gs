/**
 * Admin.gs
 * Products (with photos), Users and Settings management. Every change is written to Audit_Log.
 * Note: edits made directly in the Google Sheet are NOT recorded in Audit_Log
 * (except PINs typed in the Users sheet).
 */

// ---------------- Products ----------------

function apiGetProducts(token) {
  return run_(function () {
    const user = requirePerm_(token, 'products.view');
    const canSeeCost = hasPerm_(user, 'products.view_cost');
    const products = readTable_('Products').rows.map(function (r) {
      const price = moneyNum_(r.Selling_Price);
      const cost = moneyNum_(r.Cost);
      const p = {
        id: String(r.Product_ID).trim(), name: String(r.Product_Name).trim(), category: String(r.Category).trim(),
        price: isFinite(price) ? price : null, active: isTrue_(r.Active),
        recipeGroup: String(r.Recipe_Group || '').trim().toUpperCase() || 'NONE',
        image: normalizeImageUrl_(r.Image_URL)
      };
      if (canSeeCost) p.cost = isFinite(cost) ? cost : null;
      return p;
    }).filter(function (p) { return p.id; });
    const cats = categoryOrder_();
    products.forEach(function (p) { if (p.category && cats.indexOf(p.category) < 0) cats.push(p.category); });
    return { products: products, categories: cats, canEdit: hasPerm_(user, 'products.manage'), canSeeCost: canSeeCost };
  });
}

function apiSaveProduct(token, data) {
  return run_(function () {
    const user = requirePerm_(token, 'products.manage');
    data = data || {};
    const name = cleanText_(data.name, 60);
    const category = cleanText_(data.category, 30);
    const price = Number(data.price);
    const cost = Number(data.cost || 0);
    const group = String(data.recipeGroup || 'NONE').toUpperCase();
    const active = data.active === true;
    if (!name) throw new Error('Nama produk wajib diisi.');
    if (!category) throw new Error('Kategori wajib diisi.');
    if (!Number.isInteger(price) || price < 0 || price > 100000000) throw new Error('Harga jual harus angka Rupiah bulat.');
    if (!Number.isInteger(cost) || cost < 0 || cost > 100000000) throw new Error('Harga pokok harus angka Rupiah bulat.');
    if (RECIPE_GROUPS.indexOf(group) < 0) throw new Error('Grup resep tidak dikenal.');

    return withLock_(function () {
      const table = readTable_('Products');
      const fields = { Product_Name: name, Category: category, Selling_Price: price, Cost: cost, Active: active,
                       Recipe_Group: group, Updated_At: nowStamp_() };
      if (data.id) {
        const row = table.rows.filter(function (r) { return String(r.Product_ID).trim() === String(data.id); })[0];
        if (!row) throw new Error('Produk tidak ditemukan: ' + data.id);
        const before = { name: String(row.Product_Name), category: String(row.Category), price: moneyNum_(row.Selling_Price),
                         cost: moneyNum_(row.Cost), active: isTrue_(row.Active), group: String(row.Recipe_Group) };
        updateRow_('Products', row._row, fields);
        const priceChanged = before.price !== price || before.cost !== cost;
        audit_(user, priceChanged ? 'PRODUCT_PRICE_CHANGE' : 'PRODUCT_UPDATE', 'Product', data.id,
               { before: before, after: { name: name, category: category, price: price, cost: cost, active: active, group: group } });
        return { id: data.id };
      }
      const id = nextId_(table.rows.map(function (r) { return r.Product_ID; }), 'P', 3);
      fields.Product_ID = id;
      appendObjects_('Products', [fields]);
      audit_(user, 'PRODUCT_CREATE', 'Product', id, { name: name, category: category, price: price, cost: cost });
      return { id: id };
    });
  });
}

/** The Drive folder where product photos are kept. Created the first time. */
function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* folder deleted: make a new one */ }
  }
  const folder = DriveApp.createFolder('JayaPOS Product Photos');
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function driveIdFromUrl_(url) {
  const m = String(url || '').match(/[?&]id=([A-Za-z0-9_-]{20,})/) || String(url || '').match(/\/d\/([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : '';
}

/**
 * Saves a product photo. dataUrl is a resized JPEG made by the phone ("data:image/jpeg;base64,...").
 * Pass an empty dataUrl to remove the photo.
 */
function apiSetProductImage(token, productId, dataUrl) {
  return run_(function () {
    const user = requirePerm_(token, 'products.manage');
    const row = readTable_('Products').rows.filter(function (r) { return String(r.Product_ID).trim() === String(productId); })[0];
    if (!row) throw new Error('Produk tidak ditemukan: ' + productId);
    const oldUrl = String(row.Image_URL || '');
    let url = '';
    if (dataUrl) {
      const m = String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw new Error('File ini bukan gambar yang didukung (pakai JPG atau PNG).');
      if (m[2].length > 8 * 1024 * 1024) throw new Error('Gambar terlalu besar. Pilih foto yang lebih kecil.');
      const bytes = Utilities.base64Decode(m[2]);
      const ext = m[1] === 'image/png' ? '.png' : (m[1] === 'image/webp' ? '.webp' : '.jpg');
      const file = photoFolder_().createFile(Utilities.newBlob(bytes, m[1], String(productId) + '_' + Date.now() + ext));
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (e) {
        file.setTrashed(true);
        throw new Error('Google Drive tidak mengizinkan foto dibagikan lewat link, jadi tidak bisa tampil di kasir. (' + e.message + ')');
      }
      url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w600';
    }
    updateRow_('Products', row._row, { Image_URL: url, Updated_At: nowStamp_() });
    const oldId = driveIdFromUrl_(oldUrl);
    if (oldId && oldUrl.indexOf('drive.google.com') >= 0) {
      try {
        const f = DriveApp.getFileById(oldId);
        if (f.getParents().hasNext() && f.getParents().next().getId() === photoFolder_().getId()) f.setTrashed(true);
      } catch (e) { /* old photo not ours or already gone */ }
    }
    audit_(user, url ? 'PRODUCT_PHOTO_SET' : 'PRODUCT_PHOTO_REMOVE', 'Product', String(productId), '');
    return { id: productId, image: url };
  });
}

// ---------------- Users ----------------

/**
 * Checks extra roles / extra permissions sent from the phone.
 * Accepts an array or a text list. Returns clean arrays, without the main role.
 */
function cleanExtras_(data, role) {
  const roles = (Array.isArray(data.extraRoles) ? data.extraRoles : listOf_(data.extraRoles)).map(normRole_);
  const perms = Array.isArray(data.extraPerms) ? data.extraPerms : listOf_(data.extraPerms);
  roles.forEach(function (r) { if (EXTRA_ROLES.indexOf(r) < 0) throw new Error('Izin tambahan tidak dikenal: ' + r); });
  perms.forEach(function (p) { if (EXTRA_PERMS.indexOf(p) < 0) throw new Error('Izin tambahan tidak dikenal: ' + p); });
  return {
    roles: roles.filter(function (r, i) { return r !== role && roles.indexOf(r) === i; }),
    perms: perms.filter(function (p, i) { return perms.indexOf(p) === i; })
  };
}

function createUser_(data, actor) {
  const name = cleanText_(data.name, 60);
  if (!name) throw new Error('Nama lengkap wajib diisi.');
  const username = String(data.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    throw new Error('Username harus 3–30 karakter: huruf, angka, titik atau strip. Tanpa spasi.');
  }
  const role = normRole_(data.role);
  if (ROLES.indexOf(role) < 0) throw new Error('Role tidak dikenal.');
  const extras = cleanExtras_(data, role);
  checkPinFormat_(data.pin);
  const users = getUsers_();
  if (users.some(function (u) { return u.username === username; })) throw new Error('Username "' + username + '" sudah dipakai.');
  const id = nextId_(users.map(function (u) { return u.id; }), 'U', 3);
  const salt = newSalt_();
  appendObjects_('Users', [{
    User_ID: id, Full_Name: name, Username: username, Role: role, New_PIN: '',
    Extra_Roles: extras.roles.join(', '), Extra_Perms: extras.perms.join(', '),
    PIN_Hash: hashPin_(String(data.pin), salt), PIN_Salt: salt, Active_Status: true,
    Created_At: nowStamp_(), Updated_At: nowStamp_()
  }]);
  audit_(actor, 'USER_CREATE', 'User', id, { username: username, role: role });
  return id;
}

function apiListUsers(token) {
  return run_(function () {
    requirePerm_(token, 'users.manage');
    return {
      roles: ROLES,
      extraRoles: EXTRA_ROLES,
      extraPerms: EXTRA_PERMS,
      permLabels: PERM_LABELS,
      users: getUsers_().map(function (u) {
        return {
          id: u.id, name: u.name, username: u.username, role: u.role, active: u.active, hasPin: !!u.hash,
          extraRoles: u.extraRoles, extraPerms: u.extraPerms, roleText: roleText_(u)
        };
      })
    };
  });
}

function apiSaveUser(token, data) {
  return run_(function () {
    const actor = requirePerm_(token, 'users.manage');
    data = data || {};
    return withLock_(function () {
      if (!data.id) return { id: createUser_(data, actor) };

      const users = getUsers_();
      const u = users.filter(function (x) { return x.id === String(data.id); })[0];
      if (!u) throw new Error('Pengguna tidak ditemukan.');
      const name = cleanText_(data.name, 60);
      const role = normRole_(data.role);
      const extras = cleanExtras_(data, role);
      const active = data.active === true;
      if (!name) throw new Error('Nama lengkap wajib diisi.');
      if (ROLES.indexOf(role) < 0) throw new Error('Role tidak dikenal.');
      // Who is an admin AFTER this save (main role or extra role ADMIN)
      const after = { role: role, extraRoles: extras.roles, extraPerms: extras.perms };
      const stillAdmin = hasPerm_(after, '*') && active;
      if (u.id === actor.id && !stillAdmin && hasPerm_(actor, '*')) {
        throw new Error('Anda tidak bisa mencabut role admin Anda sendiri atau menonaktifkan diri sendiri.');
      }
      const otherAdmins = users.filter(function (x) { return x.id !== u.id && x.active && hasPerm_(x, '*'); });
      if (hasPerm_(u, '*') && !stillAdmin && !otherAdmins.length) {
        throw new Error('Harus selalu ada minimal satu admin yang aktif.');
      }
      updateRow_('Users', u.row, {
        Full_Name: name, Role: role, Active_Status: active,
        Extra_Roles: extras.roles.join(', '), Extra_Perms: extras.perms.join(', '),
        Updated_At: nowStamp_()
      });
      audit_(actor, 'USER_UPDATE', 'User', u.id, {
        before: { name: u.name, role: u.role, extraRoles: u.extraRoles, extraPerms: u.extraPerms, active: u.active },
        after: { name: name, role: role, extraRoles: extras.roles, extraPerms: extras.perms, active: active }
      });
      return { id: u.id };
    });
  });
}

function apiResetUserPin(token, userId, pin) {
  return run_(function () {
    const actor = requirePerm_(token, 'users.manage');
    checkPinFormat_(pin);
    return withLock_(function () {
      const u = getUsers_().filter(function (x) { return x.id === String(userId); })[0];
      if (!u) throw new Error('Pengguna tidak ditemukan.');
      setUserPin_(u, String(pin), actor);
      return true;
    });
  });
}

// ---------------- Settings ----------------

function apiGetSettings(token) {
  return run_(function () {
    requirePerm_(token, 'settings.manage');
    const map = getSettingsMap_();
    return SETTINGS_DEFAULTS.map(function (d) { return { key: d[0], label: SETTING_LABELS[d[0]] || d[0], value: map[d[0]], description: d[2] }; });
  });
}

function apiSaveSetting(token, key, value) {
  return run_(function () {
    const user = requirePerm_(token, 'settings.manage');
    key = String(key || '');
    const def = SETTINGS_DEFAULTS.filter(function (d) { return d[0] === key; })[0];
    if (!def) throw new Error('Pengaturan tidak dikenal.');
    const label = SETTING_LABELS[key] || key;
    let v = cleanText_(value, 300);
    const bools = ['Allow_Discount', 'Service_On_Takeaway', 'Tax_On_Takeaway', 'Show_Product_Images', 'Deduct_Stock_On_Sale', 'Require_Shift'];
    if (key === 'Costing_Method') {
      v = v.toUpperCase();
      if (v !== 'AVERAGE' && v !== 'LAST') throw new Error(label + ' harus AVERAGE atau LAST.');
    }
    if (key === 'Cash_Rounding_Mode') {
      v = v.toUpperCase();
      if (['NEAREST', 'DOWN', 'UP'].indexOf(v) < 0) throw new Error(label + ' harus NEAREST, DOWN atau UP.');
    }
    if (key === 'Tx_Prefix') {
      v = v.toUpperCase();
      if (!/^[A-Z]{1,5}$/.test(v)) throw new Error(label + ' harus 1–5 huruf (A–Z).');
    }
    if (key === 'Receipt_Width_mm' && v !== '58' && v !== '80') throw new Error(label + ' harus 58 atau 80.');
    if ((key === 'Cashier_History_Days' || key === 'Cashier_Void_Days') && !/^\d{1,3}$/.test(v)) throw new Error(label + ' harus berupa angka.');
    if (key === 'Cash_Rounding') {
      v = v.replace(/[^0-9]/g, '');
      if (v === '' || Number(v) > 100000) throw new Error(label + ' harus angka Rupiah, contoh 1000 (0 = tanpa pembulatan).');
      v = String(Number(v));
    }
    if (key === 'Max_Cash_In_Drawer' || key === 'Cash_Diff_Tolerance') {
      v = v.replace(/[^0-9]/g, '');
      if (v === '' || Number(v) > 1000000000) throw new Error(label + ' harus angka Rupiah (0 = mati).');
      v = String(Number(v));
    }
    if (key === 'Quick_Notes') {
      v = v.split(',').map(function (x) { return x.trim().slice(0, 30); }).filter(String).slice(0, 20).join(',');
    }
    if (key === 'Max_Discount_Percent') {
      const n = Number(v.replace(',', '.').replace('%', ''));
      if (!isFinite(n) || n < 0 || n > 100) throw new Error(label + ' harus angka 0 sampai 100.');
      v = String(n);
    }
    if (key === 'Service_Percent' || key === 'Tax_Percent') {
      v = v.replace(',', '.').replace('%', '').trim();
      const n = Number(v);
      if (v === '' || !isFinite(n) || n < 0 || n > 50) throw new Error(label + ' harus angka 0 sampai 50.');
      v = String(n);
    }
    if (bools.indexOf(key) >= 0) {
      v = v.toUpperCase();
      if (v !== 'TRUE' && v !== 'FALSE') throw new Error(label + ' harus TRUE atau FALSE.');
    }
    return withLock_(function () {
      const row = readTable_('Settings').rows.filter(function (r) { return String(r.Setting).trim() === key; })[0];
      const before = row ? cellText_(row.Value) : '';
      if (row) updateRow_('Settings', row._row, { Value: v });
      else appendObjects_('Settings', [{ Setting: key, Value: v, Description: def[2] }]);
      SETTINGS_CACHE_ = null;
      audit_(user, 'SETTING_UPDATE', 'Setting', key, { before: before, after: v });
      return { key: key, value: v };
    });
  });
}
