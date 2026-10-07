/**
 * Void.gs
 * Void (batal) and the notes ("Notifikasi") that go to the admin / owner.
 *
 *  - Void item  : items removed from a table bill that was already saved   -> Tables.gs (apiSaveOpenOrder)
 *  - Void bill  : a table bill with items closed without payment          -> Tables.gs (apiCancelOpenOrder)
 *  - Void paid  : a transaction that was ALREADY PAID is cancelled         -> apiVoidTransaction (below)
 *                 The sale stays in the sheet with Status VOID (nothing disappears), it is left out
 *                 of every report, and the recipe ingredients go back into stock.
 *  Every void needs a reason. Each one writes a row to the Notifications sheet; admin and owner
 *  see it under the bell icon in the app until they mark it as read.
 */

const NOTIFY_TITLES = {
  VOID_ITEM: 'Void item',
  VOID_BILL: 'Void bill (belum dibayar)',
  VOID_PAID: 'Void transaksi (sudah dibayar)',
  SHIFT_OPEN_DIFF: 'Modal awal tidak sama',
  CASH_IN: 'Kas masuk',
  CASH_OUT: 'Kas keluar',
  SETOR: 'Setor tunai (perlu konfirmasi)',
  SHIFT_CLOSED: 'Shift ditutup',
  SHIFT_DIFF: 'Shift ditutup — SELISIH KAS'
};

/** Writes one note for the admin / owner. Never blocks the action that called it. */
function notify_(user, type, refId, tableName, amount, reason, details) {
  try {
    const now = new Date();
    const who = user ? user.name : 'Sistem';
    const where = tableName ? ' di meja ' + tableName : '';
    const msg = who + ' — ' + (details || '') + where;
    const start = nextSeq_('NTSEQ_' + fmt_(now, 'yyyyMMdd'), 1);
    appendObjects_('Notifications', [{
      Notification_ID: 'NT-' + fmt_(now, 'yyyyMMdd') + '-' + String(start + 1).padStart(4, '0'),
      Timestamp: fmt_(now, 'yyyy-MM-dd HH:mm:ss'), Type: type, Title: NOTIFY_TITLES[type] || type,
      Message: String(msg).slice(0, 500), Reference_ID: refId || '', Table_Name: tableName || '',
      Amount: Math.round(amount || 0), Reason: reason || '', User_ID: user ? user.id : '', User_Name: who,
      Role: user ? user.role : '', Read_At: '', Read_By: ''
    }]);
  } catch (e) {
    console.error('notify_ failed: ' + e);
  }
}

/** Earliest date a user may void a paid transaction. */
function voidStart_(user) {
  if (hasPerm_(user.role, '*')) return '0000-00-00';
  const days = Math.max(1, parseInt(getSettingsMap_().Cashier_Void_Days, 10) || 1);
  return addDays_(todayStr_(), -(days - 1));
}

/** Void a transaction that was already paid. */
function apiVoidTransaction(token, txId, reason) {
  return run_(function () {
    const user = requirePerm_(token, 'pos.void');
    txId = String(txId || '').trim();
    if (!/^[A-Z]{1,5}-\d{8}-\d{4,}$/.test(txId)) throw new Error('Nomor transaksi tidak valid.');
    const why = checkReason_(reason);
    return withLock_(function () {
      const t = getTransactionById_(txId);
      if (!t) throw new Error('Transaksi ' + txId + ' tidak ditemukan.');
      if (t.status !== 'COMPLETED') throw new Error('Transaksi ini sudah ' + statusWord_(t.status) + '.');
      if (t.date < voidStart_(user)) {
        throw jayaError_('Kasir hanya boleh void transaksi hari ini. Transaksi yang lebih lama hanya bisa di-void oleh admin.', 'DENIED');
      }
      const stamp = nowStamp_();
      updateRow_('Transactions', t.row, { Status: 'VOID', Void_Reason: why, Void_By: user.name, Void_At: stamp });
      try {   // payments of a voided sale no longer count in the cash drawer / reports
        const upd = {};
        getPayments_(txId).forEach(function (p) { upd[p.row] = 'VOID'; });
        setColumnValues_('Payments', 'Status', upd);
      } catch (e) { console.error('void payments: ' + e); }
      let stockNote = '';
      try { stockNote = reverseSaleStock_(txId, user); }
      catch (e) { audit_(user, 'INVENTORY_ERROR', 'Transaction', txId, 'Void: ' + String(e && e.message || e)); }
      const items = getTransactionDetails_(txId);
      audit_(user, 'VOID_PAID', 'Transaction', txId, { total: t.total, method: t.method, reason: why, stock: stockNote });
      notify_(user, 'VOID_PAID', txId, t.tableName, t.total, why,
              items.map(function (i) { return i.qty + 'x ' + i.name; }).join(', ') + ' · ' + methodLabel_(t.method) +
              (t.shiftId ? ' · shift ' + t.shiftId : ''));
      return buildReceipt_(txId);
    });
  });
}

/** Puts back into stock what a sale took out. Returns a short note. */
function reverseSaleStock_(txId, user) {
  const sh = getSheet_('Inventory_Movements');
  const headers = getHeaders_(sh);
  const rows = findRowNumbers_(sh, headers, 'Reference_ID', txId);
  if (!rows.length) return 'no stock movements';
  const ings = {};
  ingredientsList_().forEach(function (i) { ings[i.id] = i; });
  const moves = [];
  rows.forEach(function (n) {
    const m = rowObject_(sh, headers, n);
    if (String(m.Movement_Type) !== 'SALE') return;
    const ing = ings[String(m.Ingredient_ID).trim()];
    if (!ing) return;
    const back = -numOr_(m.Quantity_Base, 0);
    if (back <= 0) return;
    moves.push({ ing: ing, type: 'VOID', qty: back, unit: ing.baseUnit, baseQty: back,
                 unitCost: numOr_(m.Unit_Cost_Base, ing.cost), ref: txId, notes: 'Void transaksi' });
  });
  applyMovements_(moves, user, {});
  return moves.length + ' ingredient(s) returned';
}

// ---------------- Notifications ----------------

function notifFromRow_(r) {
  return {
    id: String(r.Notification_ID), when: cellText_(r.Timestamp), type: String(r.Type), title: String(r.Title || r.Type),
    message: String(r.Message || ''), ref: String(r.Reference_ID || ''), table: String(r.Table_Name || ''),
    amount: moneyNum_(r.Amount) || 0, reason: String(r.Reason || ''), user: String(r.User_Name || ''),
    role: ROLE_LABELS[String(r.Role || '')] || String(r.Role || ''), read: !!String(r.Read_At || '').trim(),
    readBy: String(r.Read_By || ''), readAt: cellText_(r.Read_At)
  };
}

/** Number of unread notes (reads only the Read_At column). */
function notifUnreadCount_() {
  const sh = getSheet_('Notifications');
  const headers = getHeaders_(sh);
  const c = headers.indexOf('Read_At');
  const idc = headers.indexOf('Notification_ID');
  const lastRow = sh.getLastRow();
  if (c < 0 || lastRow < 2) return 0;
  const reads = sh.getRange(2, c + 1, lastRow - 1, 1).getValues();
  const ids = sh.getRange(2, idc + 1, lastRow - 1, 1).getValues();
  let n = 0;
  for (let i = 0; i < reads.length; i++) {
    if (String(ids[i][0]).trim() && !String(reads[i][0]).trim()) n++;
  }
  return n;
}

function apiGetNotifications(token, filter) {
  return run_(function () {
    requirePerm_(token, 'notifications.view');
    filter = filter || {};
    let list = readRecentRows_('Notifications', 500).map(notifFromRow_).filter(function (n) { return n.id; }).reverse();
    if (filter.unreadOnly) list = list.filter(function (n) { return !n.read; });
    return { unread: notifUnreadCount_(), items: list.slice(0, 200) };
  });
}

function apiNotificationCount(token) {
  return run_(function () {
    const user = requireSession_(token);
    if (!hasPerm_(user.role, 'notifications.view')) return { unread: 0 };
    return { unread: notifUnreadCount_() };
  });
}

/** ids: array of Notification_IDs, or 'ALL'. */
function apiMarkNotificationsRead(token, ids) {
  return run_(function () {
    const user = requirePerm_(token, 'notifications.view');
    return withLock_(function () {
      const all = ids === 'ALL';
      const want = {};
      if (!all) {
        if (!Array.isArray(ids) || ids.length > 500) throw new Error('Pilih notifikasi yang mau ditandai.');
        ids.forEach(function (id) { want[String(id)] = true; });
      }
      const stamp = nowStamp_();
      const readAt = {}, readBy = {};
      readTable_('Notifications').rows.forEach(function (r) {
        const id = String(r.Notification_ID || '').trim();
        if (!id || String(r.Read_At || '').trim()) return;
        if (all || want[id]) { readAt[r._row] = stamp; readBy[r._row] = user.name; }
      });
      setColumnValues_('Notifications', 'Read_At', readAt);
      setColumnValues_('Notifications', 'Read_By', readBy);
      return { marked: Object.keys(readAt).length, unread: notifUnreadCount_() };
    });
  });
}
