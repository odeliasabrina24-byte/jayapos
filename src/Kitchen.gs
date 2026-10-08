/**
 * Kitchen.gs
 * Kitchen and bar screens ("Layar Dapur" / "Layar Bar").
 *
 * A ticket is written to the Kitchen_Tickets sheet:
 *  - every time new items are saved on a table (one ticket per round: "Pesanan 2"),
 *  - when a takeaway order is paid,
 *  - when saved items are voided or a bill is voided (Kind VOID, shown in red as "BATAL").
 * Food (Recipe_Group FOOD) goes to the kitchen screen; drinks (BEVERAGE) and others (NONE) go to the bar.
 * Each station marks its part of the ticket "Selesai" independently.
 */

function stationOf_(grp) { return String(grp || '').toUpperCase() === 'FOOD' ? 'FOOD' : 'BAR'; }

/**
 * Writes one ticket. Never blocks the order that called it.
 * info: { orderId, tableName, guest, round, kind: 'ORDER' | 'VOID', reason, user }
 * lines: [{ id, name, qty, note, grp }]
 */
function createTicket_(info, lines, products) {
  try {
    if (!lines || !lines.length) return '';
    const items = lines.map(function (l) {
      let grp = l.grp;
      if (!grp) {
        products = products || productMap_();
        grp = products[l.id] ? products[l.id].recipeGroup : 'NONE';
      }
      const extra = modsText_(l.mods);
      return { name: String(l.name) + (extra ? ' + ' + extra : ''), qty: Number(l.qty) || 0, note: String(l.note || ''), st: stationOf_(grp),
               round: Number(l.round) || 0 };
    });
    const hasFood = items.some(function (i) { return i.st === 'FOOD'; });
    const hasBar = items.some(function (i) { return i.st === 'BAR'; });
    const now = new Date();
    const dateKey = fmt_(now, 'yyyyMMdd');
    const id = 'KT-' + dateKey + '-' + String(nextSeq_('KTSEQ_' + dateKey, 1) + 1).padStart(4, '0');
    appendObjects_('Kitchen_Tickets', [{
      Ticket_ID: id, Date: fmt_(now, 'yyyy-MM-dd'), Created_At: fmt_(now, 'yyyy-MM-dd HH:mm:ss'), Created_Ms: now.getTime(),
      Created_By: info.user ? info.user.name : '', Order_ID: info.orderId || '', Table_Name: info.tableName || '',
      Guest_Name: info.guest || '', Round: info.round || 0, Kind: info.kind || 'ORDER',
      Items_JSON: JSON.stringify({ items: items, reason: info.reason || '' }),
      Food_Status: hasFood ? 'NEW' : '', Food_Done_At: '', Bar_Status: hasBar ? 'NEW' : '', Bar_Done_At: ''
    }]);
    return id;
  } catch (e) {
    console.error('createTicket_ failed: ' + e);
    return '';
  }
}

function stationPerm_(station) {
  if (station === 'FOOD') return 'kitchen.food';
  if (station === 'BAR') return 'kitchen.bar';
  throw new Error('Layar tidak dikenal.');
}

function ticketFromRow_(r, station) {
  let data = { items: [], reason: '' };
  try { data = JSON.parse(String(r.Items_JSON || '{}')) || data; } catch (e) { /* broken cell */ }
  const statusCol = station === 'FOOD' ? 'Food_Status' : 'Bar_Status';
  const doneCol = station === 'FOOD' ? 'Food_Done_At' : 'Bar_Done_At';
  const created = cellText_(r.Created_At);
  const doneStamp = cellText_(r[doneCol]);
  let serveMin = null;                       // minutes from order to "Selesai" (finished tickets only)
  try {
    if (doneStamp && Number(r.Created_Ms)) {
      const doneMs = Utilities.parseDate(doneStamp, tz_(), 'yyyy-MM-dd HH:mm:ss').getTime();
      serveMin = Math.max(0, Math.round((doneMs - Number(r.Created_Ms)) / 60000));
    }
  } catch (e) { serveMin = null; }
  return {
    serveMin: serveMin,
    row: r._row, id: String(r.Ticket_ID), orderId: String(r.Order_ID || ''), table: String(r.Table_Name || ''),
    guest: String(r.Guest_Name || ''), round: Number(r.Round) || 0, kind: String(r.Kind || 'ORDER'),
    createdMs: Number(r.Created_Ms) || 0, time: created.slice(11, 16), date: dateText_(r.Date), by: String(r.Created_By || ''),
    items: (data.items || []).filter(function (i) { return i.st === station; }),
    reason: String(data.reason || ''),
    status: String(r[statusCol] || ''), doneAt: cellText_(r[doneCol]).slice(11, 16)
  };
}

/** Open tickets for one station (oldest first) plus the last finished ones. */
function apiGetKitchen(token, station) {
  return run_(function () {
    station = String(station || '').toUpperCase();
    requirePerm_(token, stationPerm_(station));
    const today = todayStr_();
    const yesterday = addDays_(today, -1);
    const all = readRecentRows_('Kitchen_Tickets', 400).map(function (r) { return ticketFromRow_(r, station); })
      .filter(function (t) { return t.id && t.status && t.items.length && t.date >= yesterday; });
    const open = all.filter(function (t) { return t.status === 'NEW'; });
    const done = all.filter(function (t) { return t.status === 'DONE' && t.date === today; }).reverse().slice(0, 30);
    const strip = function (t) { delete t.row; return t; };
    return { station: station, serverNow: Date.now(), open: open.map(strip), done: done.map(strip) };
  });
}

/** How many tickets are waiting for this user's screens (for the top-bar badge). Light: polled every 20 s. */
function apiKitchenCount(token) {
  return run_(function () {
    const user = requirePerm_(token, ['kitchen.food', 'kitchen.bar']);
    const yesterday = addDays_(todayStr_(), -1);
    const nowMs = Date.now();
    const rows = readRecentRows_('Kitchen_Tickets', 400).filter(function (r) {
      return r.Ticket_ID && dateText_(r.Date) >= yesterday;
    });
    const out = { FOOD: null, BAR: null, late: 0 };
    if (hasPerm_(user.role, 'kitchen.food')) out.FOOD = 0;
    if (hasPerm_(user.role, 'kitchen.bar')) out.BAR = 0;
    rows.forEach(function (r) {
      const waiting = function (col) { return String(r[col] || '') === 'NEW'; };
      const old = Number(r.Created_Ms) && (nowMs - Number(r.Created_Ms)) >= 15 * 60000;
      if (out.FOOD !== null && waiting('Food_Status')) { out.FOOD++; if (old) out.late++; }
      if (out.BAR !== null && waiting('Bar_Status')) { out.BAR++; if (old) out.late++; }
    });
    return out;
  });
}

/** Marks this station's part of a ticket as done (or back to open with undo = true). */
function apiKitchenDone(token, ticketId, station, undo) {
  return run_(function () {
    station = String(station || '').toUpperCase();
    const user = requirePerm_(token, stationPerm_(station));
    return withLock_(function () {
      const rows = rowsWhere_('Kitchen_Tickets', 'Ticket_ID', String(ticketId || ''));
      if (!rows.length) throw new Error('Tiket tidak ditemukan. Muat ulang layar.');
      const r = rows[0];
      const statusCol = station === 'FOOD' ? 'Food_Status' : 'Bar_Status';
      const doneCol = station === 'FOOD' ? 'Food_Done_At' : 'Bar_Done_At';
      if (!String(r[statusCol] || '')) throw new Error('Tiket ini tidak punya item untuk layar ini.');
      const fields = {};
      fields[statusCol] = undo ? 'NEW' : 'DONE';
      fields[doneCol] = undo ? '' : nowStamp_();
      updateRow_('Kitchen_Tickets', r._row, fields);
      if (undo) audit_(user, 'KITCHEN_UNDO', 'Ticket', String(ticketId), { station: station });
      return true;
    });
  });
}
