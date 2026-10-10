/**
 * Rsvp.gs
 * Daftar reservasi (RSVP). Hanya mencatat tamu yang akan datang; bill meja dibuka saat tamu datang,
 * jadi tidak ada pesanan yang masuk ke dapur sebelum waktunya.
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
    status: String(r.Status || 'BOOKED')
  };
}

function hmToMin_(s) {
  const p = String(s || '').split(':');
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}

/**
 * RSVP hari ini yang harus tampil di denah meja: mulai 30 menit sebelum jam RSVP,
 * dan berhenti 2 jam setelah jam RSVP (kalau tamu tidak datang). Key = nama meja (huruf kecil).
 * Meja yang sudah punya bill terbuka tetap tampil sebagai bill (lihat floorData_).
 */
function rsvpReservedMap_() {
  const nowMin = hmToMin_(fmt_(new Date(), 'HH:mm'));
  const d = todayStr_();
  const out = {};
  readTable_('Reservations').rows.map(rsvpRowToObj_)
    .filter(function (x) { return x.date === d && x.status !== 'CANCELLED' && x.table; })
    .sort(function (a, b) { return a.time < b.time ? -1 : (a.time > b.time ? 1 : 0); })
    .forEach(function (x) {
      const m = hmToMin_(x.time);
      if (nowMin < m - 30 || nowMin > m + 120) return;
      const key = x.table.trim().toLowerCase();
      if (!out[key]) out[key] = { id: x.id, guest: x.guest, pax: x.pax, time: x.time, items: x.items };
    });
  return out;
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
    const now = nowStamp_();
    return withLock_(function () {
      const id = String(data.id || '');
      if (id) {
        const row = readTable_('Reservations').rows.filter(function (r) { return String(r.Reservation_ID) === id; })[0];
        if (!row) throw new Error('RSVP tidak ditemukan. Muat ulang layar.');
        updateRow_('Reservations', row._row, { Date: date, Time: time, Guest_Name: guest, Pax: pax, Table_Name: table,
          Pesanan_Awal: items, Notes: notes, Updated_At: now });
        audit_(user, 'UPDATE', 'Reservation', id, { guest: guest, date: date, time: time });
        return { id: id };
      }
      const newId = 'RSV-' + date.replace(/-/g, '') + '-' + Utilities.getUuid().slice(0, 6).toUpperCase();
      appendObjects_('Reservations', [{ Reservation_ID: newId, Date: date, Time: time, Guest_Name: guest, Pax: pax,
        Table_Name: table, Pesanan_Awal: items, Notes: notes, Status: 'BOOKED', Created_By: user.name,
        Created_At: now, Updated_At: now }]);
      audit_(user, 'CREATE', 'Reservation', newId, { guest: guest, date: date, time: time });
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
