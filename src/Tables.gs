/**
 * Tables.gs
 * Floor plan, table layout editing, and open table bills (dine-in).
 *
 * How a table bill works:
 *  1. Staff taps a free table, types the pax and (optionally) the guest's name -> a bill is opened
 *     (Open_Orders, Status OPEN).
 *  2. Items are added and "Simpan ke meja" stores them on the bill. Every save that adds items is a new
 *     ROUND ("Pesanan 1", "Pesanan 2", ...) with its time and who took it, and is sent to the kitchen / bar
 *     screens as a new ticket. Saved lines are never mixed with new ones.
 *  3. Saved lines can only be REDUCED (= void item, needs a reason + note to the admin / owner).
 *     More of the same product is always a new line in a new round.
 *  4. "Bayar" completes the sale. A bill can be paid in parts ("split per item") or shared equally
 *     ("bagi rata", see Pos.gs). Two bills can be merged into one ("Gabung bill").
 * Every bill has a Version number. If two phones edit the same bill, the second save is
 * refused and reloaded, so nobody overwrites someone else's items.
 *
 * A saved line (Items_JSON): { lid, id, name, qty, price, disc, note, grp, round, at, by, from }
 *   lid = line id, grp = FOOD / BEVERAGE / NONE (kitchen or bar), round = order round,
 *   at = time ordered, by = who took the order, from = table it came from after "Gabung bill".
 */

function tablesList_() {
  return readTable_('Tables').rows.map(function (r) {
    const shape = String(r.Shape || 'SQUARE').trim().toUpperCase();
    return {
      row: r._row,
      id: String(r.Table_ID).trim(),
      name: String(r.Table_Name).trim(),
      area: String(r.Area || '').trim() || 'Indoor',
      seats: Math.max(0, parseInt(r.Seats, 10) || 0),
      shape: TABLE_SHAPES.indexOf(shape) >= 0 ? shape : 'SQUARE',
      x: clamp_(numOr_(r.Pos_X, 5), 0, 95),
      y: clamp_(numOr_(r.Pos_Y, 5), 0, 95),
      w: clamp_(numOr_(r.Width, 18), 6, 60),
      h: clamp_(numOr_(r.Height, 18), 6, 60),
      active: isTrue_(r.Active)
    };
  }).filter(function (t) { return t.id && t.name; });
}

function clamp_(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** Makes stored lines complete (bills saved by v2 have no line id / round). */
function normalizeLines_(items) {
  const seen = {};
  return (Array.isArray(items) ? items : []).map(function (i, k) {
    let lid = cleanLid_(i && i.lid) || ('OLD' + k);
    while (seen[lid]) lid = lid + 'x';
    seen[lid] = true;
    return {
      lid: lid, id: String(i.id || ''), name: String(i.name || ''), qty: Number(i.qty) || 0, price: Number(i.price) || 0,
      disc: i.disc && i.disc.value ? i.disc : null, note: String(i.note || ''), grp: String(i.grp || ''),
      mods: Array.isArray(i.mods) ? i.mods.map(function (m) { return { id: String(m.id), name: String(m.name), price: Number(m.price) || 0 }; }) : [],
      round: Number(i.round) || 1, at: String(i.at || ''), by: String(i.by || ''), from: String(i.from || '')
    };
  }).filter(function (i) { return i.id && i.qty > 0; });
}

function orderFromRow_(r) {
  let items = [];
  try { items = JSON.parse(String(r.Items_JSON || '[]')) || []; } catch (e) { items = []; }
  const paid = String(r.Paid_Transactions || '').split(',').map(function (x) { return x.trim(); }).filter(String);
  return {
    row: r._row,
    id: String(r.Order_ID).trim(),
    tableId: String(r.Table_ID).trim(),
    tableName: String(r.Table_Name).trim(),
    pax: Number(r.Pax) || 0,
    guestName: String(r.Guest_Name || '').trim(),
    status: String(r.Status || '').trim().toUpperCase(),
    items: normalizeLines_(items),
    subtotal: moneyNum_(r.Subtotal) || 0,
    openedAt: cellText_(r.Opened_At),
    openedMs: Number(r.Opened_Ms) || 0,
    openedBy: String(r.Opened_By || ''),
    updatedBy: String(r.Updated_By || ''),
    version: Number(r.Version) || 0,
    transactionId: String(r.Transaction_ID || ''),
    paidTx: paid,
    mergedInto: String(r.Merged_Into || '')
  };
}

function openOrders_() {
  const sh = getSheet_('Open_Orders');
  const headers = getHeaders_(sh);
  return findRowNumbers_(sh, headers, 'Status', 'OPEN').map(function (n) { return orderFromRow_(rowObject_(sh, headers, n)); });
}

function getOpenOrder_(orderId) {
  const sh = getSheet_('Open_Orders');
  const headers = getHeaders_(sh);
  const rows = findRowNumbers_(sh, headers, 'Order_ID', String(orderId || ''));
  return rows.length ? orderFromRow_(rowObject_(sh, headers, rows[0])) : null;
}

/** What the phone needs to show a bill. */
function publicOrder_(o, km) {
  km = km || kitchenStateMap_();
  return { id: o.id, tableId: o.tableId, tableName: o.tableName, pax: o.pax, guestName: o.guestName, status: o.status,
           items: o.items, subtotal: o.subtotal, openedAt: o.openedAt, openedMs: o.openedMs, openedBy: o.openedBy,
           updatedBy: o.updatedBy, version: o.version, paidCount: o.paidTx.length,
           kitchen: km[o.id] || {} };          // round -> NEW | PROSES | READY | SERVED
}

function floorData_(user) {
  const tables = tablesList_().filter(function (t) { return t.active; });
  const open = {};
  const km = kitchenStateMap_();
  openOrders_().forEach(function (o) {
    if (!open[o.tableId]) {
      open[o.tableId] = { orderId: o.id, pax: o.pax, guest: o.guestName, subtotal: o.subtotal, ready: countReady_(km[o.id]),
                          items: o.items.reduce(function (s, i) { return s + (Number(i.qty) || 0); }, 0),
                          rounds: o.items.reduce(function (m, i) { return Math.max(m, i.round); }, 0), paidCount: o.paidTx.length,
                          openedMs: o.openedMs, openedBy: o.openedBy, version: o.version, tableName: o.tableName };
    }
  });
  const areas = listSetting_('Table_Areas');
  tables.forEach(function (t) { if (areas.indexOf(t.area) < 0) areas.push(t.area); });
  return {
    areas: areas,
    tables: tables.map(function (t) {
      return { id: t.id, name: t.name, area: t.area, seats: t.seats, shape: t.shape, x: t.x, y: t.y, w: t.w, h: t.h };
    }),
    open: open,
    reserved: rsvpReservedMap_(tables, open),
    alerts: rsvpDueReminders_(tables, open),
    canServe: hasPerm_(user, 'tables.serve'),
    canEditLayout: hasPerm_(user, 'tables.layout'),
    serverNow: Date.now()
  };
}

function apiGetFloor(token) {
  return run_(function () {
    return floorData_(requirePerm_(token, ['tables.serve', 'tables.layout']));
  });
}

function checkPax_(pax) {
  const p = Number(pax);
  if (!Number.isInteger(p) || p < 1 || p > 99) throw new Error('Jumlah tamu (pax) harus angka 1 sampai 99.');
  return p;
}

function nextOrderId_() {
  const dateKey = fmt_(new Date(), 'yyyyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = 'ORDSEQ_' + dateKey;
  let seq = Number(props.getProperty(key) || 0);
  let id;
  do { seq++; id = 'ORD-' + dateKey + '-' + String(seq).padStart(3, '0'); } while (getOpenOrder_(id));
  props.setProperty(key, String(seq));
  return id;
}

/** Opens a bill on a free table, or returns the bill already open on it. */
function apiOpenTable(token, tableId, pax, guestName) {
  return run_(function () {
    const user = requirePerm_(token, 'tables.serve');
    const p = checkPax_(pax);
    const guest = cleanGuest_(guestName);
    return withLock_(function () {
      const table = tablesList_().filter(function (t) { return t.id === String(tableId) && t.active; })[0];
      if (!table) throw new Error('Meja ini sudah tidak ada. Muat ulang layar Meja.');
      const existing = openOrders_().filter(function (o) { return o.tableId === table.id; })[0];
      if (existing) {
        const r = publicOrder_(existing);
        r.alreadyOpen = true;
        return r;
      }
      const now = new Date();
      const stamp = fmt_(now, 'yyyy-MM-dd HH:mm:ss');
      const id = nextOrderId_();
      appendObjects_('Open_Orders', [{
        Order_ID: id, Table_ID: table.id, Table_Name: table.name, Pax: p, Status: 'OPEN', Items_JSON: '[]',
        Subtotal: 0, Opened_At: stamp, Opened_Ms: now.getTime(), Opened_By: user.name, Updated_At: stamp,
        Updated_By: user.name, Version: 1, Transaction_ID: '', Closed_At: '', Guest_Name: guest, Paid_Transactions: '',
        Merged_Into: ''
      }]);
      audit_(user, 'TABLE_OPEN', 'Order', id, { table: table.name, pax: p, guest: guest });
      return publicOrder_(getOpenOrder_(id));
    });
  });
}

function apiGetOpenOrder(token, orderId) {
  return run_(function () {
    requirePerm_(token, 'tables.serve');
    const o = getOpenOrder_(orderId);
    if (!o) throw new Error('Bill tidak ditemukan. Muat ulang layar Meja.');
    if (o.status !== 'OPEN') throw new Error('Bill ini sudah ' + statusWord_(o.status) + '.');
    return publicOrder_(o);
  });
}

function checkReason_(reason) {
  const r = cleanText_(reason, 150);
  if (r.length < 3) throw jayaError_('Tulis alasan void (contoh: salah input, tamu batal, makanan rusak).', 'REASON_NEEDED');
  return r;
}

function linesValue_(lines) {
  return lines.reduce(function (s, l) {
    const gross = lineUnit_(l) * l.qty;
    return s + gross - Math.min(gross, discountAmount_(l.disc, gross));
  }, 0);
}

/**
 * Saves a table bill ("Simpan ke meja").
 * data: { orderId, version, pax, guestName, voidReason, lines: [{ lid, productId, qty, disc, note }] }
 *  - lines already on the bill keep their round / time / note; their qty may only go DOWN (void, needs reason)
 *  - lines with a new lid are a new round: sent to the kitchen / bar screens
 */
function apiSaveOpenOrder(token, data) {
  return run_(function () {
    const user = requirePerm_(token, 'tables.serve');
    data = data || {};
    const p = checkPax_(data.pax);
    const guest = cleanGuest_(data.guestName);
    const incoming = parseLines_(data.lines || data.items || [], true);
    const products = productMap_();
    const canDiscount = hasPerm_(user, 'pos.sell');
    return withLock_(function () {
      const o = getOpenOrder_(data.orderId);
      if (!o) throw new Error('Bill tidak ditemukan. Muat ulang layar Meja.');
      if (o.status !== 'OPEN') throw jayaError_('Bill ini sudah ' + statusWord_(o.status) + '.', 'STALE');
      if (o.version !== Number(data.version)) {
        throw jayaError_('Bill ini baru diubah di HP lain (oleh ' + o.updatedBy + '). Bill sudah dimuat ulang. Cek lagi lalu simpan.', 'STALE');
      }
      const inByLid = {};
      incoming.forEach(function (l) {
        if (!l.lid) throw new Error('Data baris pesanan tidak lengkap. Muat ulang JayaPOS.');
        if (inByLid[l.lid]) throw new Error('Ada baris pesanan ganda. Muat ulang JayaPOS.');
        inByLid[l.lid] = l;
      });
      const storedByLid = {};
      o.items.forEach(function (s) { storedByLid[s.lid] = s; });

      const now = new Date();
      const out = [], removed = [], added = [];
      o.items.forEach(function (s) {
        const inc = inByLid[s.lid];
        if (!inc) { removed.push(Object.assign({}, s)); return; }
        if (inc.productId !== s.id) throw jayaError_('Data bill tidak cocok. Bill sudah dimuat ulang.', 'STALE');
        if (inc.qty > s.qty) {
          throw jayaError_('Untuk menambah ' + s.name + ', ketuk produknya lagi supaya masuk sebagai pesanan baru (dapur perlu tahu).', 'STALE');
        }
        if (inc.qty < s.qty) removed.push(Object.assign({}, s, { qty: s.qty - inc.qty }));
        const prod = products[s.id];
        const line = Object.assign({}, s, { qty: inc.qty, price: prod ? prod.price : s.price, grp: s.grp || (prod ? prod.recipeGroup : 'NONE'),
          mods: (s.mods || []).map(function (m) { const mp = products[m.id]; return { id: m.id, name: m.name, price: mp ? mp.price : m.price }; }) });
        if (canDiscount) line.disc = inc.disc;
        out.push(line);
      });
      const round = o.items.reduce(function (m, i) { return Math.max(m, i.round); }, 0) + 1;
      incoming.forEach(function (l) {
        if (storedByLid[l.lid]) return;
        const prod = products[l.productId];
        if (!prod) throw jayaError_('Ada produk di keranjang yang sudah tidak tersedia (' + l.productId + '). Menu akan dimuat ulang.', 'PRICE_CHANGED');
        if (prod.soldOut) throw jayaError_(prod.name + ' sedang HABIS. Hapus dari pesanan baru. Menu sudah dimuat ulang.', 'PRICE_CHANGED');
        const mods = priceMods_(l.mods, prod, null, products).map(function (m) { return { id: m.id, name: m.name, price: m.price }; });
        const line = { lid: l.lid, id: prod.id, name: prod.name, qty: l.qty, price: prod.price, disc: canDiscount ? l.disc : null,
                       note: l.note, grp: prod.recipeGroup, mods: mods, round: round, at: fmt_(now, 'HH:mm'), by: user.name, from: '' };
        out.push(line);
        added.push(line);
      });

      out.forEach(function (l) {
        if (l.disc && l.disc.type === 'AMT' && l.disc.value > lineUnit_(l) * l.qty) throw new Error('Diskon untuk ' + l.name + ' lebih besar dari harganya.');
      });
      const priced = out.map(function (l) { return { total: lineUnit_(l) * l.qty, disc: l.disc }; });
      const tot = calcTotals_(priced, {}, chargeSettings_());
      checkDiscountAllowed_(user, tot, priced, null);

      const reason = removed.length ? checkReason_(data.voidReason) : '';
      const stamp = fmt_(now, 'yyyy-MM-dd HH:mm:ss');
      updateRow_('Open_Orders', o.row, {
        Items_JSON: JSON.stringify(out), Subtotal: tot.itemsNet, Pax: p, Guest_Name: guest,
        Updated_At: stamp, Updated_By: user.name, Version: o.version + 1
      });
      const info = { orderId: o.id, tableName: o.tableName, guest: guest, user: user };
      if (added.length) createTicket_(Object.assign({ round: round, kind: 'ORDER' }, info), added, products);
      if (removed.length) {
        createTicket_(Object.assign({ round: 0, kind: 'VOID', reason: reason }, info), removed, products);
        const amount = linesValue_(removed);
        audit_(user, 'VOID_ITEM', 'Order', o.id, { table: o.tableName, items: removed.map(function (x) { return { name: x.name, qty: x.qty, round: x.round }; }), reason: reason });
        notify_(user, 'VOID_ITEM', o.id, o.tableName, amount, reason,
                removed.map(function (x) { return x.qty + 'x ' + x.name + ' (pesanan ' + x.round + ')'; }).join(', '));
      }
      if (p !== o.pax) audit_(user, 'ORDER_PAX_CHANGE', 'Order', o.id, { table: o.tableName, from: o.pax, to: p });
      const res = publicOrder_(getOpenOrder_(o.id));
      res.addedRound = added.length ? round : 0;
      return res;
    });
  });
}

/**
 * Closes a bill without payment.
 *  - Empty bill (no items): just frees the table.
 *  - Bill with items = VOID BILL: needs a reason and sends a note to the admin / owner (and a "BATAL" to the kitchen).
 */
function apiCancelOpenOrder(token, orderId, version, reason) {
  return run_(function () {
    const user = requirePerm_(token, 'tables.serve');
    return withLock_(function () {
      const o = getOpenOrder_(orderId);
      if (!o || o.status !== 'OPEN') throw new Error('Bill ini sudah tidak terbuka.');
      if (o.version !== Number(version)) throw jayaError_('Bill ini baru diubah di HP lain. Bill sudah dimuat ulang.', 'STALE');
      const hasItems = o.items.length > 0;
      const why = hasItems ? checkReason_(reason) : '';
      const stamp = nowStamp_();
      updateRow_('Open_Orders', o.row, { Status: 'CANCELLED', Closed_At: stamp, Updated_At: stamp, Updated_By: user.name,
                                         Version: o.version + 1 });
      audit_(user, hasItems ? 'VOID_BILL' : 'ORDER_CANCEL', 'Order', o.id, { table: o.tableName, items: o.items, reason: why });
      if (hasItems) {
        createTicket_({ orderId: o.id, tableName: o.tableName, guest: o.guestName, user: user, round: 0, kind: 'VOID', reason: why }, o.items);
        notify_(user, 'VOID_BILL', o.id, o.tableName, linesValue_(o.items), why,
                o.items.map(function (i) { return i.qty + 'x ' + i.name; }).join(', ') + ' · ' + o.pax + ' pax' +
                (o.guestName ? ' · ' + o.guestName : ''));
      }
      return true;
    });
  });
}

/** Moves a bill to another free table. */
function apiMoveOpenOrder(token, orderId, version, newTableId) {
  return run_(function () {
    const user = requirePerm_(token, 'tables.serve');
    return withLock_(function () {
      const o = getOpenOrder_(orderId);
      if (!o || o.status !== 'OPEN') throw new Error('Bill ini sudah tidak terbuka.');
      if (o.version !== Number(version)) throw jayaError_('Bill ini baru diubah di HP lain. Bill sudah dimuat ulang.', 'STALE');
      const table = tablesList_().filter(function (t) { return t.id === String(newTableId) && t.active; })[0];
      if (!table) throw new Error('Meja itu tidak ada.');
      if (openOrders_().some(function (x) { return x.tableId === table.id; })) throw new Error(table.name + ' sudah punya bill terbuka. Pakai "Gabung bill" kalau mau digabung.');
      updateRow_('Open_Orders', o.row, { Table_ID: table.id, Table_Name: table.name, Updated_At: nowStamp_(),
                                         Updated_By: user.name, Version: o.version + 1 });
      audit_(user, 'ORDER_MOVE_TABLE', 'Order', o.id, { from: o.tableName, to: table.name });
      return publicOrder_(getOpenOrder_(o.id));
    });
  });
}

/**
 * Gabung bill: moves every line of the SOURCE bill into the TARGET bill (the one open on the phone).
 * The source table becomes free. Pax are added up, guest names joined, each line remembers its table.
 */
function apiMergeOrders(token, targetId, targetVersion, sourceId) {
  return run_(function () {
    const user = requirePerm_(token, 'tables.serve');
    return withLock_(function () {
      const t = getOpenOrder_(targetId);
      const s = getOpenOrder_(sourceId);
      if (!t || t.status !== 'OPEN') throw new Error('Bill ini sudah tidak terbuka.');
      if (!s || s.status !== 'OPEN') throw jayaError_('Bill meja yang mau digabung sudah tidak terbuka. Muat ulang.', 'STALE');
      if (t.id === s.id) throw new Error('Pilih meja lain untuk digabung.');
      if (t.version !== Number(targetVersion)) throw jayaError_('Bill ini baru diubah di HP lain. Bill sudah dimuat ulang.', 'STALE');
      const used = {};
      t.items.forEach(function (i) { used[i.lid] = true; });
      const moved = s.items.map(function (i) {
        let lid = i.lid;
        while (used[lid]) lid = ('M' + Utilities.getUuid().replace(/-/g, '')).slice(0, 12);
        used[lid] = true;
        return Object.assign({}, i, { lid: lid, from: i.from || s.tableName });
      });
      const items = t.items.concat(moved);
      const guests = [t.guestName, s.guestName].filter(String);
      const pax = Math.min(99, t.pax + s.pax);
      const stamp = nowStamp_();
      updateRow_('Open_Orders', t.row, {
        Items_JSON: JSON.stringify(items), Subtotal: linesValue_(items), Pax: pax, Guest_Name: guests.join(' + ').slice(0, 80),
        Paid_Transactions: t.paidTx.concat(s.paidTx).join(','), Updated_At: stamp, Updated_By: user.name, Version: t.version + 1
      });
      updateRow_('Open_Orders', s.row, { Status: 'MERGED', Merged_Into: t.id, Closed_At: stamp, Updated_At: stamp,
                                         Updated_By: user.name, Version: s.version + 1 });
      audit_(user, 'ORDER_MERGE', 'Order', t.id, { into: t.tableName, from: s.tableName, fromOrder: s.id, items: s.items.length });
      return publicOrder_(getOpenOrder_(t.id));
    });
  });
}

/** Saves the whole floor plan from the layout editor (admin). */
function apiSaveLayout(token, list) {
  return run_(function () {
    const user = requirePerm_(token, 'tables.layout');
    if (!Array.isArray(list) || list.length > 200) throw new Error('Data denah tidak valid.');
    const clean = list.map(function (t) {
      const name = cleanText_(t && t.name, 20);
      if (!name) throw new Error('Setiap meja harus punya nama.');
      const shape = String(t.shape || 'SQUARE').toUpperCase();
      if (TABLE_SHAPES.indexOf(shape) < 0) throw new Error('Bentuk meja ' + name + ' tidak dikenal.');
      const seats = Number(t.seats);
      if (!Number.isInteger(seats) || seats < 1 || seats > 50) throw new Error('Jumlah kursi ' + name + ' harus 1 sampai 50.');
      return {
        id: String(t.id || '').trim(), name: name, area: cleanText_(t.area, 30) || 'Indoor', seats: seats, shape: shape,
        w: Math.round(clamp_(numOr_(t.w, 18), 6, 60)), h: Math.round(clamp_(numOr_(t.h, 18), 6, 60)),
        x: 0, y: 0, rawX: numOr_(t.x, 5), rawY: numOr_(t.y, 5)
      };
    });
    clean.forEach(function (t) {
      t.x = Math.round(clamp_(t.rawX, 0, 100 - t.w));
      t.y = Math.round(clamp_(t.rawY, 0, 100 - t.h));
    });
    const seen = {};
    clean.forEach(function (t) {
      const k = t.area.toLowerCase() + '|' + t.name.toLowerCase();
      if (seen[k]) throw new Error('Ada dua meja bernama "' + t.name + '" di ' + t.area + '.');
      seen[k] = true;
    });

    return withLock_(function () {
      const existing = tablesList_();
      const byId = {};
      existing.forEach(function (t) { byId[t.id] = t; });
      const busy = {};
      openOrders_().forEach(function (o) { busy[o.tableId] = true; });
      const keep = {};
      clean.forEach(function (t) { if (t.id && byId[t.id]) keep[t.id] = true; });
      const removed = [];
      existing.forEach(function (t) {
        if (t.active && !keep[t.id]) {
          if (busy[t.id]) throw new Error('Meja ' + t.name + ' masih punya bill terbuka, jadi tidak bisa dihapus. Bayar atau void bill-nya dulu.');
          removed.push(t);
        }
      });

      const stamp = nowStamp_();
      const ids = existing.map(function (t) { return t.id; });
      const added = [];
      clean.forEach(function (t) {
        const fields = { Table_Name: t.name, Area: t.area, Seats: t.seats, Shape: t.shape, Pos_X: t.x, Pos_Y: t.y,
                         Width: t.w, Height: t.h, Active: true, Updated_At: stamp };
        const old = t.id && byId[t.id];
        if (old) {
          const same = old.name === t.name && old.area === t.area && old.seats === t.seats && old.shape === t.shape &&
                       Math.round(old.x) === t.x && Math.round(old.y) === t.y && Math.round(old.w) === t.w &&
                       Math.round(old.h) === t.h && old.active;
          if (!same) updateRow_('Tables', old.row, fields);
          if (old.name !== t.name && busy[old.id]) {
            const o = openOrders_().filter(function (x) { return x.tableId === old.id; })[0];
            if (o) updateRow_('Open_Orders', o.row, { Table_Name: t.name });
          }
        } else {
          const id = nextId_(ids, 'T', 2);
          ids.push(id);
          fields.Table_ID = id;
          appendObjects_('Tables', [fields]);
          added.push(t.name);
        }
      });
      removed.forEach(function (t) { updateRow_('Tables', t.row, { Active: false, Updated_At: stamp }); });
      audit_(user, 'TABLE_LAYOUT_SAVE', 'Tables', '', { tables: clean.length, added: added, removed: removed.map(function (t) { return t.name; }) });
      return floorData_(user);
    });
  });
}
