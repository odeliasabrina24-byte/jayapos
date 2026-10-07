/**
 * Shift.gs
 * Cash drawer ("Kas & Shift"): counting the opening cash, cash in / out, handing cash to the owner
 * ("setor"), and closing the shift with a BLIND count.
 *
 * How it prevents cheating:
 *  - Opening: the cashier counts every note/coin. If it differs from what the previous shift left in the
 *    drawer, the owner / admin gets a notification straight away.
 *  - While open: every Rupiah that leaves the drawer is a recorded movement with a name and a reason
 *    (Kas keluar). A "setor" stays PENDING until the owner / admin confirms they really received it
 *    (and the person who hands over cash cannot confirm it themselves).
 *  - Closing: the cashier counts the drawer WITHOUT seeing how much there should be. The system then
 *    compares: expected = opening + cash sales + cash in - cash out - setor. The difference is saved and
 *    sent to the owner / admin. Only owner / admin see the expected amount while the shift is open.
 *  - All payments are tied to the open shift (Payments.Shift_ID), so a sale cannot "disappear" from it;
 *    a voided sale is visible in the notifications.
 */

function shiftFromRow_(r) {
  return {
    row: r._row, id: String(r.Shift_ID || '').trim(), date: dateText_(r.Date), status: String(r.Status || '').trim().toUpperCase(),
    openedAt: cellText_(r.Opened_At), openedBy: String(r.Opened_By || ''), openedById: String(r.Opened_By_ID || ''),
    opening: moneyNum_(r.Opening_Cash) || 0, previousLeft: r.Previous_Left === '' || r.Previous_Left == null ? null : (moneyNum_(r.Previous_Left) || 0),
    openingDiff: moneyNum_(r.Opening_Diff) || 0,
    closedAt: cellText_(r.Closed_At), closedBy: String(r.Closed_By || ''),
    cashSales: moneyNum_(r.Cash_Sales) || 0, cashIn: moneyNum_(r.Cash_In) || 0, cashOut: moneyNum_(r.Cash_Out) || 0,
    setor: moneyNum_(r.Setor_Total) || 0, expected: moneyNum_(r.Expected_Cash) || 0, counted: moneyNum_(r.Counted_Cash) || 0,
    difference: moneyNum_(r.Difference) || 0, leftForNext: moneyNum_(r.Left_For_Next) || 0, finalSetor: moneyNum_(r.Final_Setor) || 0,
    txCount: Number(r.Tx_Count) || 0, notes: String(r.Notes || ''), nonCash: String(r.Non_Cash || '')
  };
}

/** The open shift, or null. */
function currentShift_() {
  const sh = getSheet_('Shifts');
  const headers = getHeaders_(sh);
  const rows = findRowNumbers_(sh, headers, 'Status', 'OPEN');
  if (!rows.length) return null;
  return shiftFromRow_(rowObject_(sh, headers, rows[rows.length - 1]));
}

function lastClosedShift_() {
  const rows = readRecentRows_('Shifts', 40).map(shiftFromRow_).filter(function (s) { return s.id && s.status === 'CLOSED'; });
  return rows.length ? rows[rows.length - 1] : null;
}

/** Called before taking money. Throws when a shift is required but none is open. */
function shiftForPayment_(settings) {
  const s = currentShift_();
  if (!s && isTrue_((settings || getSettingsMap_()).Require_Shift)) {
    throw jayaError_('Shift kas belum dibuka. Buka dulu di ☰ → Kas & Shift (hitung modal awal), lalu bayar lagi.', 'NO_SHIFT');
  }
  return s;
}

function moveFromRow_(r) {
  return {
    id: String(r.Movement_ID || ''), shiftId: String(r.Shift_ID || ''), when: cellText_(r.Timestamp), time: cellText_(r.Timestamp).slice(11, 16),
    type: String(r.Type || ''), amount: moneyNum_(r.Amount) || 0, reason: String(r.Reason || ''), user: String(r.User_Name || ''),
    userId: String(r.User_ID || ''), status: String(r.Status || ''), confirmedBy: String(r.Confirmed_By || ''),
    confirmedAt: cellText_(r.Confirmed_At), confirmNote: String(r.Confirm_Note || '')
  };
}

/** Live numbers of a shift, from the Payments and Cash_Movements sheets. */
function shiftNumbers_(shift) {
  const pays = readSince_('Payments', 'Date', shift.date).filter(function (p) {
    return String(p.Shift_ID) === shift.id && String(p.Status || 'COMPLETED') !== 'VOID';
  });
  const by = {};
  const tx = {};
  let cashSales = 0;
  pays.forEach(function (p) {
    const m = String(p.Method);
    const amt = moneyNum_(p.Amount) || 0;
    if (!by[m]) by[m] = { method: m, label: methodLabel_(m), total: 0, count: 0 };
    by[m].total += amt;
    by[m].count++;
    if (m === 'CASH') cashSales += amt;
    tx[String(p.Transaction_ID)] = true;
  });
  const moves = readSince_('Cash_Movements', 'Date', shift.date).map(moveFromRow_).filter(function (m) { return m.shiftId === shift.id; });
  const sum = function (type, ok) {
    return moves.filter(function (m) { return m.type === type && ok(m); }).reduce(function (s, m) { return s + m.amount; }, 0);
  };
  const all = function () { return true; };
  const cashIn = sum('CASH_IN', all);
  const cashOut = sum('CASH_OUT', all);
  const setor = sum('SETOR', function (m) { return m.status !== 'REJECTED'; });
  const setorPending = sum('SETOR', function (m) { return m.status === 'PENDING'; });
  return {
    cashSales: cashSales, cashIn: cashIn, cashOut: cashOut, setor: setor, setorPending: setorPending,
    expected: shift.opening + cashSales + cashIn - cashOut - setor,
    byMethod: PAYMENT_ORDER.filter(function (k) { return by[k]; }).map(function (k) { return by[k]; }),
    txCount: Object.keys(tx).length, moves: moves
  };
}

function drawerFull_(shift, settings) {
  const max = Math.max(0, numOr_((settings || getSettingsMap_()).Max_Cash_In_Drawer, 0));
  if (!max) return false;
  return shiftNumbers_(shift).expected > max;
}

/**
 * The cash count from the phone: either per note/coin (data.count) or just the total (data.total).
 * Returns { total, json }.
 */
function readCash_(data) {
  if (data && data.mode === 'TOTAL') {
    const t = Number(data.total);
    if (!Number.isInteger(t) || t < 0 || t > 1000000000) throw new Error('Isi total uang di laci (angka Rupiah).');
    return { total: t, json: JSON.stringify({ total: t }) };
  }
  return readCount_(data && data.count);
}

/** Validates a count { "100000": 3, "50000": 2, ... } and returns its total. */
function readCount_(count) {
  if (!count || typeof count !== 'object') throw new Error('Isi hitungan uang di laci.');
  let total = 0;
  const clean = {};
  CASH_DENOMS.forEach(function (d) {
    const v = count[d] === undefined || count[d] === null || count[d] === '' ? 0 : Number(count[d]);
    if (!Number.isInteger(v) || v < 0 || v > 100000) throw new Error('Jumlah lembar/keping Rp ' + d + ' tidak valid.');
    if (v) { clean[d] = v; total += d * v; }
  });
  return { total: total, json: JSON.stringify(clean) };
}

function shiftState_(user) {
  const canView = hasPerm_(user.role, 'shift.view');
  const canManage = hasPerm_(user.role, 'shift.manage');
  const canConfirm = hasPerm_(user.role, 'cash.confirm');
  const s = getSettingsMap_();
  const cur = currentShift_();
  const last = lastClosedShift_();
  let shift = null;
  if (cur) {
    const n = shiftNumbers_(cur);
    shift = {
      id: cur.id, openedAt: cur.openedAt, openedBy: cur.openedBy, opening: cur.opening, previousLeft: cur.previousLeft,
      openingDiff: cur.openingDiff, txCount: n.txCount,
      moves: n.moves.map(function (m) { delete m.userId; return m; }).reverse(),
      nonCash: n.byMethod.filter(function (m) { return m.method !== 'CASH'; }),
      drawerFull: Math.max(0, numOr_(s.Max_Cash_In_Drawer, 0)) > 0 && n.expected > numOr_(s.Max_Cash_In_Drawer, 0)
    };
    if (canView) {    // blind count: only owner / admin see what SHOULD be in the drawer
      shift.cashSales = n.cashSales; shift.cashIn = n.cashIn; shift.cashOut = n.cashOut; shift.setor = n.setor;
      shift.setorPending = n.setorPending; shift.expected = n.expected; shift.byMethod = n.byMethod;
    }
  }
  let pending = [];
  if (canConfirm) {
    pending = readRecentRows_('Cash_Movements', 400).map(moveFromRow_)
      .filter(function (m) { return m.type === 'SETOR' && m.status === 'PENDING'; }).reverse()
      .map(function (m) { m.mine = m.userId === user.id; delete m.userId; return m; });
  }
  let history = [];
  if (canView) {
    history = readRecentRows_('Shifts', 60).map(shiftFromRow_).filter(function (x) { return x.id && x.status === 'CLOSED'; })
      .reverse().slice(0, 30).map(function (x) { delete x.row; return x; });
  }
  return {
    shift: shift,
    lastClosed: last ? { id: last.id, closedAt: last.closedAt, closedBy: last.closedBy, leftForNext: last.leftForNext } : null,
    denoms: CASH_DENOMS, canManage: canManage, canView: canView, canConfirm: canConfirm,
    required: isTrue_(s.Require_Shift), tolerance: Math.max(0, numOr_(s.Cash_Diff_Tolerance, 0)),
    openBills: (function () { try { return openOrders_().length; } catch (e) { return 0; } })(),
    pending: pending, history: history
  };
}

function apiGetShift(token) {
  return run_(function () {
    return shiftState_(requirePerm_(token, ['shift.manage', 'shift.view', 'cash.confirm']));
  });
}

/** Open a shift: data = { count: { denom: n }, note } */
function apiOpenShift(token, data) {
  return run_(function () {
    const user = requirePerm_(token, 'shift.manage');
    data = data || {};
    const c = readCash_(data);
    const note = cleanText_(data.note, 150);
    return withLock_(function () {
      const cur = currentShift_();
      if (cur) throw new Error('Shift sudah dibuka oleh ' + cur.openedBy + ' (' + cur.openedAt.slice(11, 16) + '). Tutup dulu sebelum membuka yang baru.');
      const last = lastClosedShift_();
      const prev = last ? last.leftForNext : null;
      const diff = prev === null ? 0 : c.total - prev;
      if (diff < 0 && note.length < 3) {
        throw new Error('Uang kurang ' + rpText_(-diff) + ' dari yang ditinggal shift sebelumnya (' + rpText_(prev) + '). Tulis alasannya di Catatan (minimal 3 huruf).');
      }
      const now = new Date();
      const dateKey = fmt_(now, 'yyyyMMdd');
      const id = 'SH-' + dateKey + '-' + String(nextSeq_('SHSEQ_' + dateKey, 1) + 1).padStart(2, '0');
      const stamp = fmt_(now, 'yyyy-MM-dd HH:mm:ss');
      appendObjects_('Shifts', [{
        Shift_ID: id, Date: fmt_(now, 'yyyy-MM-dd'), Status: 'OPEN', Opened_At: stamp, Opened_By: user.name, Opened_By_ID: user.id,
        Opening_Cash: c.total, Opening_Count: c.json, Previous_Left: prev === null ? '' : prev, Opening_Diff: diff,
        Notes: note, Outlet_ID: getSettingsMap_().Outlet_ID || ''
      }]);
      audit_(user, 'SHIFT_OPEN', 'Shift', id, { opening: c.total, previousLeft: prev, diff: diff });
      if (diff !== 0) {
        notify_(user, 'SHIFT_OPEN_DIFF', id, '', diff, note,
                'Modal awal dihitung ' + rpText_(c.total) + ', yang ditinggal shift sebelumnya (' + last.closedBy + ') ' + rpText_(prev) +
                '. Selisih ' + rpText_(diff) + (diff < 0 ? ' (KURANG)' : ' (LEBIH)'));
      }
      return shiftState_(user);
    });
  });
}

function rpText_(n) {
  n = Math.round(Number(n) || 0);
  return (n < 0 ? '-Rp ' : 'Rp ') + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

const CASH_MOVE_WORDS = { CASH_IN: 'Kas masuk', CASH_OUT: 'Kas keluar', SETOR: 'Setor tengah shift' };

/** Cash in / cash out / setor during the shift: data = { type, amount, reason } */
function apiCashMove(token, data) {
  return run_(function () {
    const user = requirePerm_(token, 'shift.manage');
    data = data || {};
    const type = String(data.type || '');
    if (CASH_MOVE_TYPES.indexOf(type) < 0) throw new Error('Jenis kas tidak dikenal.');
    const amount = Number(data.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 100000000) throw new Error('Isi jumlah uang (angka bulat lebih dari 0).');
    const reason = cleanText_(data.reason, 150);
    if (type === 'CASH_OUT' && reason.length < 3) throw jayaError_('Tulis untuk apa uangnya (contoh: beli es batu, bayar parkir).', 'REASON_NEEDED');
    return withLock_(function () {
      const cur = currentShift_();
      if (!cur) throw jayaError_('Shift kas belum dibuka.', 'NO_SHIFT');
      if (type !== 'CASH_IN' && amount > shiftNumbers_(cur).expected) {
        throw new Error('Jumlahnya lebih besar dari uang tunai yang seharusnya ada di laci. Cek lagi.');
      }
      const now = new Date();
      const dateKey = fmt_(now, 'yyyyMMdd');
      const id = 'CM-' + dateKey + '-' + String(nextSeq_('CMSEQ_' + dateKey, 1) + 1).padStart(4, '0');
      appendObjects_('Cash_Movements', [{
        Movement_ID: id, Shift_ID: cur.id, Timestamp: fmt_(now, 'yyyy-MM-dd HH:mm:ss'), Date: fmt_(now, 'yyyy-MM-dd'), Type: type,
        Amount: amount, Reason: reason || (type === 'CASH_IN' ? 'Tambah modal' : type === 'SETOR' ? 'Setor tunai' : ''),
        User_ID: user.id, User_Name: user.name, Status: type === 'SETOR' ? 'PENDING' : 'OK', Confirmed_By: '', Confirmed_At: '',
        Confirm_Note: '', Count: ''
      }]);
      audit_(user, 'CASH_' + type, 'Shift', cur.id, { id: id, amount: amount, reason: reason });
      notify_(user, type, id, '', amount, reason, CASH_MOVE_WORDS[type] + ' ' + rpText_(amount) +
              (type === 'SETOR' ? ' — menunggu konfirmasi diterima' : ''));
      return shiftState_(user);
    });
  });
}

/** Owner / admin confirm (accept = true) or reject a setor. */
function apiConfirmSetor(token, movementId, accept, note) {
  return run_(function () {
    const user = requirePerm_(token, 'cash.confirm');
    const why = cleanText_(note, 150);
    if (!accept && why.length < 3) throw jayaError_('Tulis alasan menolak setor (contoh: uang kurang Rp 50.000).', 'REASON_NEEDED');
    return withLock_(function () {
      const rows = rowsWhere_('Cash_Movements', 'Movement_ID', String(movementId || ''));
      if (!rows.length) throw new Error('Setor tidak ditemukan.');
      const m = moveFromRow_(rows[0]);
      if (m.type !== 'SETOR' || m.status !== 'PENDING') throw new Error('Setor ini sudah dikonfirmasi.');
      if (m.userId === user.id) throw jayaError_('Setor harus dikonfirmasi oleh orang lain yang menerima uangnya (owner/admin lain).', 'DENIED');
      updateRow_('Cash_Movements', rows[0]._row, { Status: accept ? 'RECEIVED' : 'REJECTED', Confirmed_By: user.name,
                                                   Confirmed_At: nowStamp_(), Confirm_Note: why });
      audit_(user, accept ? 'SETOR_RECEIVED' : 'SETOR_REJECTED', 'Cash', m.id, { amount: m.amount, from: m.user, note: why });
      return shiftState_(user);
    });
  });
}

/**
 * Close the shift with a blind count. data = { count, leave, note }
 *  leave = cash left in the drawer as modal for the next shift; the rest is a final setor (PENDING).
 */
function apiCloseShift(token, data) {
  return run_(function () {
    const user = requirePerm_(token, 'shift.manage');
    data = data || {};
    const c = readCash_(data);
    const leave = Number(data.leave);
    if (!Number.isInteger(leave) || leave < 0) throw new Error('Isi modal yang ditinggal di laci untuk shift berikutnya (boleh 0).');
    if (leave > c.total) throw new Error('Modal yang ditinggal lebih besar dari uang yang dihitung.');
    const note = cleanText_(data.note, 150);
    return withLock_(function () {
      const cur = currentShift_();
      if (!cur) throw new Error('Tidak ada shift yang terbuka.');
      const n = shiftNumbers_(cur);
      const diff = c.total - n.expected;
      const finalSetor = c.total - leave;
      const now = new Date();
      const stamp = fmt_(now, 'yyyy-MM-dd HH:mm:ss');
      updateRow_('Shifts', cur.row, {
        Status: 'CLOSED', Closed_At: stamp, Closed_By: user.name, Closed_By_ID: user.id, Cash_Sales: n.cashSales, Cash_In: n.cashIn,
        Cash_Out: n.cashOut, Setor_Total: n.setor, Expected_Cash: n.expected, Counted_Cash: c.total, Difference: diff,
        Closing_Count: c.json, Left_For_Next: leave, Final_Setor: finalSetor, Tx_Count: n.txCount,
        Non_Cash: JSON.stringify(n.byMethod.map(function (m) { return { m: m.method, t: m.total, n: m.count }; })),
        Notes: [cur.notes, note].filter(String).join(' | ').slice(0, 300)
      });
      if (finalSetor > 0) {
        const dateKey = fmt_(now, 'yyyyMMdd');
        appendObjects_('Cash_Movements', [{
          Movement_ID: 'CM-' + dateKey + '-' + String(nextSeq_('CMSEQ_' + dateKey, 1) + 1).padStart(4, '0'), Shift_ID: cur.id,
          Timestamp: stamp, Date: fmt_(now, 'yyyy-MM-dd'), Type: 'SETOR', Amount: finalSetor, Reason: 'Setor tutup shift',
          User_ID: user.id, User_Name: user.name, Status: 'PENDING', Confirmed_By: '', Confirmed_At: '', Confirm_Note: '', Count: ''
        }]);
      }
      const tol = Math.max(0, numOr_(getSettingsMap_().Cash_Diff_Tolerance, 0));
      const flagged = Math.abs(diff) > tol;
      audit_(user, 'SHIFT_CLOSE', 'Shift', cur.id, { expected: n.expected, counted: c.total, diff: diff, leave: leave, setor: finalSetor });
      notify_(user, flagged ? 'SHIFT_DIFF' : 'SHIFT_CLOSED', cur.id, '', diff, note,
              'Uang dihitung ' + rpText_(c.total) + ', seharusnya ' + rpText_(n.expected) + ' → selisih ' + rpText_(diff) +
              (diff < 0 ? ' (KURANG)' : diff > 0 ? ' (LEBIH)' : '') + '. Setor ' + rpText_(finalSetor) + ' (menunggu konfirmasi), modal ditinggal ' +
              rpText_(leave) + '. ' + n.txCount + ' transaksi.');
      const state = shiftState_(user);
      state.closed = { id: cur.id, expected: n.expected, counted: c.total, difference: diff, finalSetor: finalSetor, leave: leave,
                       flagged: flagged, cashSales: n.cashSales, txCount: n.txCount };
      return state;
    });
  });
}

/** Full detail of one shift (owner / admin). */
function apiGetShiftDetail(token, shiftId) {
  return run_(function () {
    requirePerm_(token, 'shift.view');
    const rows = rowsWhere_('Shifts', 'Shift_ID', String(shiftId || ''));
    if (!rows.length) throw new Error('Shift tidak ditemukan.');
    const s = shiftFromRow_(rows[0]);
    const n = shiftNumbers_(s);
    delete s.row;
    s.byMethod = n.byMethod;
    if (s.status === 'OPEN') {
      s.cashSales = n.cashSales; s.cashIn = n.cashIn; s.cashOut = n.cashOut; s.setor = n.setor; s.expected = n.expected; s.txCount = n.txCount;
    }
    s.moves = n.moves.map(function (m) { delete m.userId; return m; });
    let open = {}, close = {};
    try { open = JSON.parse(String(rows[0].Opening_Count || '{}')); } catch (e) { open = {}; }
    try { close = JSON.parse(String(rows[0].Closing_Count || '{}')); } catch (e) { close = {}; }
    s.openingCount = open;
    s.closingCount = close;
    return s;
  });
}
