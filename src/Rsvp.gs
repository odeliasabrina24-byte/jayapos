/**
 * Rsvp.gs
 * Daftar reservasi (RSVP). Hanya mencatat tamu yang akan datang; bill meja dibuka saat tamu datang.
 *
 * Meja khusus RSVP (Strict = YES): meja tampil sebagai catatan RSVP sejak pagi, dan staff diingatkan
 * lewat notif HP 15 menit sebelum jam RSVP. Pre-order (Preorder_JSON) dimuat ke bill saat tamu datang.
 */

function rsvpCheckDate_(d) {
  const s = String(d || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Tanggal harus format 2026-10-11.');
  return s;
}

function rsvpCheckTime_(t) {
  const s = String(t || '');
  if (!/^\d{2}:\d{2}$/.test(s)) throw new Error('Jam harus format 19:00.');
  return s;
}

function hmToMin_(s) {
  const p = String(s || '').split(':');
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}

function parsePreorder_(s) {
  try {
    const a = JSON.parse(String(s || '[]'));
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

function rsvpRowToObj_(r) {
  return {
    id: String(r.Reservation_ID || ''),
    date: cellText_(r.Date),
    time: cellText_(r.Time),
    guest: String(r.Guest_Name || ''),
    pax: Number(r.Pax) || 0,
    table: String(r.Table_Name || ''),
    items: String(r.Pesanan_Awal || ''),
    notes: String(r.Notes || ''),
    status: String(r.Status || 'BOOKED'),
    strict: String(r.Strict || '').toUpperCase() === 'YES',
    preorder: parsePreorder_(r.Preorder_JSON),
    remindedAt: String(r.Reminded_At || '')
  };
}

/** Pre-order dibersihkan: hanya produk aktif, qty 1-99, maksimal 30 baris. */
function sanitizePreorder_(list) {
  if (!Array.isArray(list)) return [];
  const byId = {};
  getActiveProducts_().forEach(function (p) { byId[p.id] = p; });
  const out = [];
  list.forEach(function (x) {
    const id = String((x && x.id) || '').slice(0, 40);
    const p = byId[id];
    if (!p || out.length >= 30) return;
    const qty = Math.max(1, Math.min(99, parseInt(x.qty, 10) || 1));
    out.push({ id: id, name: p.name, qty: qty });
  });
  return out;
}

/** RSVP aktif hari ini (sudah diurutkan jam), lengkap dengan nomor baris. */
function rsvpToday_(d) {
  return readTable_('Reservations').rows
    .map(function (r) { return Object.assign(rsvpRowToObj_(r), { row: r._row }); })
    .filter(function (x) { return x.date === d && x.status !== 'CANCELLED' && x.table; })
    .sort(function (a, b) { return a.time < b.time ? -1 : (a.time > b.time ? 1 : 0); });
}

/**
 * RSVP yang harus tampil di denah meja. Meja khusus RSVP: dari pagi. Lainnya: 30 menit sebelum jam.
 * Keduanya berhenti 2 jam setelah jam RSVP (kalau tamu tidak datang).
 * Key = nama meja (huruf kecil).
 */
function rsvpReservedMap_(tables, open) {
  const nowMin = hmToMin_(fmt_(new Date(), 'HH:mm'));
  const idByName = {};
  (tables || []).forEach(function (t) { idByName[String(t.name).trim().toLowerCase()] = t.id; });
  const out = {};
  rsvpToday_(todayStr_()).forEach(function (x) {
    const m = hmToMin_(x.time);
    const from = x.strict ? 0 : m - 30;
    if (nowMin < from || nowMin > m + 120) return;
    const key = x.table.trim().toLowerCase();
    if (out[key]) return;
    out[key] = { id: x.id, guest: x.guest, pax: x.pax, time: x.time, items: x.items, strict: x.strict, preorder: x.preorder };
  });
  return out;
}

/**
 * Pengingat HP untuk meja khusus RSVP, 15 menit sebelum jam RSVP (sampai 2 jam sesudahnya).
 * Dikirim sekali (Reminded_At). Jalan saat denah meja dibuka, jadi perlu layar meja terbuka.
 * Mengembalikan teks untuk toast di layar staff yang sedang membuka denah.
 */
function rsvpDueReminders_(tables, open) {
  const nowMin = hmToMin_(fmt_(new Date(), 'HH:mm'));
  const idByName = {};
  (tables || []).forEach(function (t) { idByName[String(t.name).trim().toLowerCase()] = t.id; });
  const alerts = [];
  try {
    withLock_(function () {
      rsvpToday_(todayStr_()).forEach(function (x) {
        const m = hmToMin_(x.time);
        if (!x.strict || x.remindedAt || nowMin < m - 15 || nowMin > m + 120) return;
        const o = open[idByName[x.table.trim().toLowerCase()]];
        let body = 'Meja ' + x.table + ' khusus RSVP jam ' + x.time + ' · ' + x.guest + ' (' + x.pax + ' pax). Ingatkan tamu RSVP.';
        if (o) body += '\nMeja masih dipakai: ' + (o.guest || 'tamu walk-in') + ' (' + o.pax + ' pax). Pindahkan tamu.';
        updateRow_('Reservations', x.row, { Reminded_At: nowStamp_() });
        notifyPush_('Pengingat RSVP', body, 'high');
        alerts.push(body.split('\n')[0]);
      });
    });
  } catch (e) {
    console.error('rsvpDueReminders_ gagal: ' + e);
  }
  return alerts;
}

/** Pemicu tiap 5 menit: kirim pengingat RSVP walau tidak ada layar meja yang terbuka. Dipasang sekali (ulang aman). */
function installRsvpReminderTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'rsvpReminderTick_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('rsvpReminderTick_').timeBased().everyMinutes(5).create();
}

function rsvpReminderTick_() {
  const open = {};
  openOrders_().forEach(function (o) {
    if (!open[o.tableId]) open[o.tableId] = { guest: o.guestName, pax: o.pax };
  });
  rsvpDueReminders_(tablesList_(), open);
}

function apiGetRsvp(token, date) {
  return run_(function () {
    requirePerm_(token, 'rsvp.manage');
    const d = date ? rsvpCheckDate_(date) : todayStr_();
    const rows = readTable_('Reservations').rows
      .map(rsvpRowToObj_)
      .filter(function (x) { return x.date === d && x.status !== 'CANCELLED'; })
      .sort(function (a, b) { return a.time < b.time ? -1 : (a.time > b.time ? 1 : 0); });
    return { date: d, rows: rows };
  });
}

/** Daftar menu aktif untuk memilih pre-order di form RSVP. */
function apiGetRsvpMenu(token) {
  return run_(function () {
    requirePerm_(token, 'rsvp.manage');
    return getActiveProducts_().map(function (p) { return { id: p.id, name: p.name }; });
  });
}

function apiSaveRsvp(token, data) {
  return run_(function () {
    const user = requirePerm_(token, 'rsvp.manage');
    if (!data || typeof data !== 'object') throw new Error('Data RSVP tidak ada.');
    const date = rsvpCheckDate_(data.date);
    if (date < todayStr_()) throw new Error('Tanggal RSVP sudah lewat.');
    const time = rsvpCheckTime_(data.time);
    const guest = cleanText_(data.guest, 40);
    if (guest.length < 2) throw new Error('Isi nama tamu (minimal 2 huruf).');
    const pax = checkPax_(data.pax);
    const table = cleanText_(data.table, 20);
    const items = cleanText_(data.items, 300);
    const notes = cleanText_(data.notes, 200);
    const strict = !!table && (data.strict === true || String(data.strict).toLowerCase() === 'true');
    const preorder = sanitizePreorder_(data.preorder);
    const now = nowStamp_();
    return withLock_(function () {
      const id = String(data.id || '');
      if (id) {
        const row = readTable_('Reservations').rows.filter(function (r) { return String(r.Reservation_ID) === id; })[0];
        if (!row) throw new Error('RSVP tidak ditemukan. Muat ulang layar.');
        const changedSlot = cellText_(row.Date) !== date || cellText_(row.Time) !== time;
        const fields = { Date: date, Time: time, Guest_Name: guest, Pax: pax, Table_Name: table, Pesanan_Awal: items,
          Notes: notes, Strict: strict ? 'YES' : 'NO', Preorder_JSON: JSON.stringify(preorder), Updated_At: now };
        if (changedSlot) fields.Reminded_At = '';   // jam berubah: pengingat dikirim lagi
        updateRow_('Reservations', row._row, fields);
        audit_(user, 'UPDATE', 'Reservation', id, { guest: guest, date: date, time: time, strict: strict });
        return { id: id };
      }
      const newId = 'RSV-' + date.replace(/-/g, '') + '-' + Utilities.getUuid().slice(0, 6).toUpperCase();
      appendObjects_('Reservations', [{ Reservation_ID: newId, Date: date, Time: time, Guest_Name: guest, Pax: pax,
        Table_Name: table, Pesanan_Awal: items, Notes: notes, Status: 'BOOKED', Created_By: user.name,
        Created_At: now, Updated_At: now, Strict: strict ? 'YES' : 'NO', Preorder_JSON: JSON.stringify(preorder),
        Reminded_At: '' }]);
      audit_(user, 'CREATE', 'Reservation', newId, { guest: guest, date: date, time: time, strict: strict });
      return { id: newId };
    });
  });
}

function apiCancelRsvp(token, id) {
  return run_(function () {
    const user = requirePerm_(token, 'rsvp.manage');
    return withLock_(function () {
      const key = String(id || '');
      const row = readTable_('Reservations').rows.filter(function (r) { return String(r.Reservation_ID) === key; })[0];
      if (!row) throw new Error('RSVP tidak ditemukan. Muat ulang layar.');
      updateRow_('Reservations', row._row, { Status: 'CANCELLED', Updated_At: nowStamp_() });
      audit_(user, 'CANCEL', 'Reservation', key, {});
      return { id: key };
    });
  });
}
