/**
 * Kitchen.gs
 * Kitchen and bar screens ("Layar Dapur" / "Layar Bar") and the "Siap diantar" screen.
 *
 * A ticket is written to the Kitchen_Tickets sheet:
 *  - every time new items are saved on a table (one ticket per round: "Pesanan 2"),
 *  - when a takeaway order is paid,
 *  - when saved items are voided or a bill is voided (Kind VOID, shown in red as "BATAL").
 * Food (Recipe_Group FOOD) goes to the kitchen screen; drinks (BEVERAGE) and others (NONE) go to the bar.
 *
 * Progress is counted per portion, not per ticket. Each item in Items_JSON has:
 *   qty  - portions ordered
 *   rdy  - portions ready in the kitchen/bar (can be partial: 2 of 3)
 *   srv  - portions already delivered to the table (srv <= rdy <= qty)
 * The station status (Food_Status / Bar_Status) is derived from these counts and kept in sync:
 *   NEW (belum dimulai) -> PROSES (sedang dibuat) -> DONE (semua siap) -> SERVED (semua sudah diantar).
 * Round state for the table (stationStates_): NEW | PROSES | PART (sebagian siap, belum diantar) | DONE | SERVED.
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
               round: Number(l.round) || 0, rdy: 0, srv: 0 };
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

/** { items, reason } of one ticket row (both stations). */
function ticketData_(r) {
  let data = { items: [], reason: '' };
  try { data = JSON.parse(String(r.Items_JSON || '{}')) || data; } catch (e) { /* broken cell */ }
  data.items = data.items || [];
  data.reason = String(data.reason || '');
  return data;
}

function ticketItems_(r) { return ticketData_(r).items; }

/** Portions for one station on one ticket: tot = ordered, rdy = ready, srv = delivered. */
function itemCounts_(items, station) {
  let tot = 0, rdy = 0, srv = 0;
  (items || []).forEach(function (i) {
    if (i.st !== station) return;
    const q = Number(i.qty) || 0;
    const r = Math.min(q, Number(i.rdy) || 0);
    tot += q;
    rdy += r;
    srv += Math.min(r, Number(i.srv) || 0);
  });
  return { tot: tot, rdy: rdy, srv: srv };
}

/** Portions ready in the kitchen/bar and not yet delivered. */
function unitsToServe_(i) {
  const q = Number(i.qty) || 0;
  return Math.max(0, Math.min(q, Number(i.rdy) || 0) - (Number(i.srv) || 0));
}

/** Queue status of one station on one ticket: NEW -> PROSES -> DONE (all ready) -> SERVED (all delivered). */
function stationQueue_(items, station, started) {
  const c = itemCounts_(items, station);
  if (c.tot && c.rdy >= c.tot) return c.srv >= c.tot ? 'SERVED' : 'DONE';
  return started ? 'PROSES' : 'NEW';
}

/** Round state for one station, over all tickets of the round. */
function roundStationState_(rows, station) {
  const col = station === 'FOOD' ? 'Food_Status' : 'Bar_Status';
  let tot = 0, rdy = 0, srv = 0, started = false;
  rows.forEach(function (r) {
    const c = itemCounts_(ticketItems_(r), station);
    tot += c.tot; rdy += c.rdy; srv += c.srv;
    const colVal = String(r[col] || '');
    if (c.tot && (c.rdy > 0 || (colVal && colVal !== 'NEW'))) started = true;
  });
  if (!tot) return '';
  if (srv >= tot) return 'SERVED';
  if (rdy >= tot) return 'DONE';
  if (rdy > srv) return 'PART';                  // some portions ready, not all yet
  return started ? 'PROSES' : 'NEW';
}

/** { FOOD: state, BAR: state } for one round. Only stations that the round has. */
function stationStates_(rows) {
  const out = {};
  ['FOOD', 'BAR'].forEach(function (st) {
    const s = roundStationState_(rows, st);
    if (s) out[st] = s;
  });
  return out;
}

/** { orderId: { "1": { FOOD: .., BAR: .. }, "2": {..} } } for all recent order tickets (one sheet read). */
function kitchenStateMap_() {
  const groups = {};
  readRecentRows_('Kitchen_Tickets', 400).forEach(function (r) {
    if (!r.Ticket_ID || String(r.Kind || '') !== 'ORDER' || !r.Order_ID) return;
    const oid = String(r.Order_ID), rd = String(Number(r.Round) || 0);
    groups[oid] = groups[oid] || {};
    (groups[oid][rd] = groups[oid][rd] || []).push(r);
  });
  const out = {};
  Object.keys(groups).forEach(function (oid) {
    out[oid] = {};
    Object.keys(groups[oid]).forEach(function (rd) { out[oid][rd] = stationStates_(groups[oid][rd]); });
  });
  return out;
}

/** Rounds with something ready to deliver (all of it, or part of it). */
function countReady_(stateObj) {
  return Object.keys(stateObj || {}).filter(function (k) {
    return Object.keys(stateObj[k] || {}).some(function (st) {
      return stateObj[k][st] === 'DONE' || stateObj[k][st] === 'PART';
    });
  }).length;
}

/**
 * Writes Items_JSON and the station columns (status + Done_At) of one ticket from its item counts.
 * forceNew: station whose items are sent back to the queue (undo), or ''.
 */
function saveTicketItems_(r, data, forceNew) {
  const fields = { Items_JSON: JSON.stringify(data) };
  [['FOOD', 'Food_Status', 'Food_Done_At'], ['BAR', 'Bar_Status', 'Bar_Done_At']].forEach(function (p) {
    const old = String(r[p[1]] || '');
    if (!old) return;                                   // this ticket has no items for that station
    const c = itemCounts_(data.items, p[0]);
    const started = forceNew !== p[0] && (old !== 'NEW' || c.rdy > 0);
    const q = stationQueue_(data.items, p[0], started);
    fields[p[1]] = q;
    fields[p[2]] = (q === 'DONE' || q === 'SERVED') ? (cellText_(r[p[2]]) || nowStamp_()) : '';
  });
  updateRow_('Kitchen_Tickets', r._row, fields);
}

function ticketFromRow_(r, station) {
  const data = ticketData_(r);
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
  const colVal = String(r[statusCol] || '');
  const c = itemCounts_(data.items, station);
  const started = !!colVal && (colVal !== 'NEW' || c.rdy > 0);
  return {
    serveMin: serveMin,
    row: r._row, id: String(r.Ticket_ID), orderId: String(r.Order_ID || ''), table: String(r.Table_Name || ''),
    guest: String(r.Guest_Name || ''), round: Number(r.Round) || 0, kind: String(r.Kind || 'ORDER'),
    createdMs: Number(r.Created_Ms) || 0, time: created.slice(11, 16), date: dateText_(r.Date), by: String(r.Created_By || ''),
    items: data.items.map(function (i, idx) {
      const q = Number(i.qty) || 0;
      return { idx: idx, name: i.name, qty: q, note: i.note || '', st: i.st, round: i.round,
               rdy: Math.min(q, Number(i.rdy) || 0), srv: Math.min(q, Number(i.srv) || 0) };
    }).filter(function (i) { return i.st === station; }),
    reason: data.reason,
    status: colVal ? stationQueue_(data.items, station, started) : '',
    ready: c.rdy, total: c.tot, served: c.srv,
    doneAt: cellText_(r[doneCol]).slice(11, 16)
  };
}

/** Kasir/server: delivers everything that is ready on a round ("Sudah diantar"). Partial rounds deliver the ready part. */
/** Each delivery of an item as {n, at}. Items saved before v3.4.2 have only the last time. */
function serveLog_(i) {
  if (Array.isArray(i.srvLog) && i.srvLog.length) return i.srvLog;
  return Number(i.srv) > 0 ? [{ n: Number(i.srv), at: i.srvAt || '' }] : [];
}

function apiServeRound(token, orderId, round) {
  return run_(function () {
    const user = requirePerm_(token, 'tables.serve');
    return withLock_(function () {
      const oid = String(orderId || ''), rd = Number(round) || 0;
      const rows = readRecentRows_('Kitchen_Tickets', 400).filter(function (r) {
        return r.Ticket_ID && String(r.Kind || '') === 'ORDER' && String(r.Order_ID || '') === oid && (Number(r.Round) || 0) === rd;
      });
      if (!rows.length) throw new Error('Tidak ada pesanan dapur untuk pesanan ' + rd + '.');
      const ready = rows.some(function (r) { return ticketItems_(r).some(function (i) { return unitsToServe_(i) > 0; }); });
      if (!ready) throw new Error('Belum ada yang siap di dapur/bar untuk pesanan ' + rd + '.');
      rows.forEach(function (r) {
        const data = ticketData_(r);
        let changed = false;
        data.items.forEach(function (i) {
          const n = unitsToServe_(i);
          if (n > 0) {
            const at = String(nowStamp_()).slice(11, 16);
            i.srv = (Number(i.srv) || 0) + n;
            i.srvAt = at;
            i.srvLog = (Array.isArray(i.srvLog) ? i.srvLog : []).concat([{ n: n, at: at }]);   // every delivery keeps its own time
            changed = true;
          }
        });
        if (changed) saveTicketItems_(r, data, '');
      });
      audit_(user, 'SERVED', 'Order', oid, { round: rd });
      return { orderId: oid, round: rd, state: 'SERVED' };
    });
  });
}

/** Layar "Siap diantar" (kasir / server): rounds of open tables with something ready (or still cooking). Polled every 15 s. */
function apiGetServe(token) {
  return run_(function () {
    requirePerm_(token, 'tables.serve');
    return serveBoard_();
  });
}

/**
 * Orders the serve screens watch: open tables, and orders already PAID whose food is still on its way.
 * Paying before the food is ready is normal, so payment alone must not remove an order from the queue.
 */
function serveOrders_() {
  const out = {};
  openOrders_().forEach(function (o) { out[o.id] = o; });
  const sh = getSheet_('Open_Orders');
  const headers = getHeaders_(sh);
  findRowNumbers_(sh, headers, 'Status', 'PAID').forEach(function (n) {
    const o = orderFromRow_(rowObject_(sh, headers, n));
    if (!out[o.id]) out[o.id] = o;
  });
  return out;
}

/** Kitchen tickets of the serve-able orders. PAID orders count only from yesterday on, so old leftovers stay out. */
function serveTickets_(orders) {
  const yesterday = addDays_(todayStr_(), -1);
  return readRecentRows_('Kitchen_Tickets', 400).filter(function (r) {
    if (!r.Ticket_ID || String(r.Kind || '') !== 'ORDER') return false;
    const o = orders[String(r.Order_ID || '')];
    return !!o && (o.status === 'OPEN' || dateText_(r.Date) >= yesterday);
  }).sort(function (a, b) { return (Number(a.Created_Ms) || 0) - (Number(b.Created_Ms) || 0); });
}

/** Serve board: ready / cooking / all rounds. Shared by the Siap diantar screen and the Beranda count. */
function serveBoard_() {
  const orders = serveOrders_();
  const rows = serveTickets_(orders);
  const groups = {};
  rows.forEach(function (r) {
    const key = String(r.Order_ID) + '|' + (Number(r.Round) || 0);
    (groups[key] = groups[key] || []).push(r);
  });
  const ready = [], cooking = [], all = [];
  Object.keys(groups).forEach(function (key) {
    const rs = groups[key];
    const o = orders[String(rs[0].Order_ID)];
    const states = stationStates_(rs);
    const stations = Object.keys(states);
    if (!stations.length) return;
    const hasLeft = stations.some(function (st) { return states[st] !== 'SERVED'; });
    const isReady = stations.some(function (st) { return states[st] === 'DONE' || states[st] === 'PART'; });
    const lines = [];
    let readyMs = 0, readyAt = '';
    rs.forEach(function (r) {
      const colVal = {}; colVal.FOOD = String(r.Food_Status || ''); colVal.BAR = String(r.Bar_Status || '');
      ['FOOD', 'BAR'].forEach(function (st) {
        const doneCol = st === 'FOOD' ? 'Food_Done_At' : 'Bar_Done_At';
        const stamp = cellText_(r[doneCol]);
        try {                                        // earliest "siap" moment of the round
          const ms = stamp ? Utilities.parseDate(stamp, tz_(), 'yyyy-MM-dd HH:mm:ss').getTime() : 0;
          if (ms && (!readyMs || ms < readyMs)) { readyMs = ms; readyAt = stamp.slice(11, 16); }
        } catch (e) { /* broken stamp: skip */ }
      });
      const data = ticketData_(r);
      data.items.forEach(function (i) {
        if (i.st !== 'FOOD' && i.st !== 'BAR') return;
        const q = Number(i.qty) || 0;
        const rd = Math.min(q, Number(i.rdy) || 0), sv = Math.min(rd, Number(i.srv) || 0);
        let status;
        if (sv >= q) status = 'SERVED';
        else if (rd >= q) status = 'DONE';
        else if (rd > 0) status = 'PART';
        else status = colVal[i.st] && colVal[i.st] !== 'NEW' ? 'PROSES' : 'NEW';
        lines.push({ qty: q, name: i.name, note: i.note || '', st: i.st, status: status, rdy: rd, srv: sv, servedAt: i.srvAt || '',
          serves: serveLog_(i) });
      });
    });
    const createdMs = Math.min.apply(null, rs.map(function (r) { return Number(r.Created_Ms) || 0; }).filter(Boolean));
    const readyStamped = !!readyMs;
    if (isReady && !readyMs) readyMs = createdMs;   // no stamp yet (only part is ready): age counts from the order
    const card = {
      orderId: o.id, round: Number(rs[0].Round) || 0, table: o.tableName, guest: o.guestName || '', pax: o.pax || 0,
      time: cellText_(rs[0].Created_At).slice(11, 16), createdMs: createdMs, by: String(rs[0].Created_By || ''),
      stations: states, lines: lines, readyAt: readyAt, readyStamped: readyStamped,
      readyMs: isReady ? readyMs : 0, state: !hasLeft ? 'SERVED' : isReady ? 'READY' : 'COOKING'
    };
    all.push(card);
    if (!hasLeft) return;                           // fully delivered: only in the all-orders view
    (isReady ? ready : cooking).push(card);
  });
  ready.sort(function (a, b) { return a.readyMs - b.readyMs; });
  cooking.sort(function (a, b) { return a.createdMs - b.createdMs; });
  all.sort(function (a, b) { return a.createdMs - b.createdMs; });
  return { serverNow: Date.now(), ready: ready, cooking: cooking, all: all };
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
    const open = all.filter(function (t) { return t.status === 'NEW' || t.status === 'PROSES'; });
    const done = all.filter(function (t) { return (t.status === 'DONE' || t.status === 'SERVED') && t.date === today; }).reverse().slice(0, 30);
    const strip = function (t) { delete t.row; return t; };
    // Totals for the screen header: portions still to make and tables waiting (e.g. 4 minuman dari 1 meja)
    const tbl = {};
    const summary = { portions: 0, tables: 0 };
    open.forEach(function (t) {
      const p = t.items.reduce(function (s, i) { return s + Math.max(0, i.qty - i.rdy); }, 0);
      if (p > 0) { summary.portions += p; tbl[t.table] = true; }
    });
    summary.tables = Object.keys(tbl).length;
    return { station: station, serverNow: Date.now(), open: open.map(strip), done: done.map(strip), summary: summary };
  });
}

/** Numbers for the top-bar badge: tickets waiting for this user's screen, late ones, and rounds ready to deliver. Polled every 20 s. */
function apiKitchenCount(token) {
  return run_(function () {
    const user = requirePerm_(token, ['kitchen.food', 'kitchen.bar', 'tables.serve']);
    const yesterday = addDays_(todayStr_(), -1);
    const nowMs = Date.now();
    const rows = readRecentRows_('Kitchen_Tickets', 400).filter(function (r) {
      return r.Ticket_ID && dateText_(r.Date) >= yesterday;
    });
    const out = { FOOD: null, BAR: null, BAR_TABLES: 0, late: 0, READY: null };
    const barTables = {};
    if (hasPerm_(user, 'kitchen.food')) out.FOOD = 0;
    if (hasPerm_(user, 'kitchen.bar')) out.BAR = 0;
    if (hasPerm_(user, 'tables.serve')) {
      out.READY = serveBoard_().ready.length;      // same rounds as the Siap diantar screen
    }
    const isWaiting = function (st) { return st === 'NEW' || st === 'PROSES'; };
    rows.forEach(function (r) {
      const waiting = function (col) { return isWaiting(String(r[col] || '')); };
      const old = Number(r.Created_Ms) && (nowMs - Number(r.Created_Ms)) >= 15 * 60000;
      if (out.FOOD !== null && waiting('Food_Status')) { out.FOOD++; if (old) out.late++; }
      if (out.BAR !== null && waiting('Bar_Status')) {
        // count drinks (portions) still to make, not tickets
        const left = ticketItems_(r).filter(function (i) { return i.st === 'BAR'; })
          .reduce(function (s, i) { return s + Math.max(0, (Number(i.qty) || 0) - (Number(i.rdy) || 0)); }, 0);
        if (left > 0) { out.BAR += left; barTables[String(r.Table_Name || '')] = true; }
        if (old) out.late++;
      }
    });
    out.BAR_TABLES = Object.keys(barTables).length;
    return out;
  });
}

/** Kitchen/bar starts a ticket: NEW -> PROSES ("sedang dibuat"). */
function apiKitchenStart(token, ticketId, station) {
  return run_(function () {
    station = String(station || '').toUpperCase();
    const user = requirePerm_(token, stationPerm_(station));
    return withLock_(function () {
      const rows = rowsWhere_('Kitchen_Tickets', 'Ticket_ID', String(ticketId || ''));
      if (!rows.length) throw new Error('Tiket tidak ditemukan. Muat ulang layar.');
      const r = rows[0];
      const statusCol = station === 'FOOD' ? 'Food_Status' : 'Bar_Status';
      if (String(r[statusCol] || '') !== 'NEW') throw new Error('Tiket ini sudah dimulai atau sudah selesai.');
      updateRow_('Kitchen_Tickets', r._row, { [statusCol]: 'PROSES' });
      return true;
    });
  });
}

/**
 * Kitchen/bar marks how many portions of one item are ready (partial is fine: 2 of 3).
 * count is clamped to 0..qty and never below what was already delivered.
 */
function apiKitchenSetReady(token, ticketId, station, idx, count) {
  return run_(function () {
    station = String(station || '').toUpperCase();
    requirePerm_(token, stationPerm_(station));
    return withLock_(function () {
      const rows = rowsWhere_('Kitchen_Tickets', 'Ticket_ID', String(ticketId || ''));
      if (!rows.length) throw new Error('Tiket tidak ditemukan. Muat ulang layar.');
      const r = rows[0];
      const statusCol = station === 'FOOD' ? 'Food_Status' : 'Bar_Status';
      if (!String(r[statusCol] || '')) throw new Error('Tiket ini tidak punya item untuk layar ini.');
      const data = ticketData_(r);
      const i = data.items[Number(idx)];
      if (!i || i.st !== station) throw new Error('Item tidak ditemukan. Muat ulang layar.');
      const q = Number(i.qty) || 0, sv = Number(i.srv) || 0;
      const n = Math.max(sv, Math.min(q, Math.floor(Number(count) || 0)));
      i.rdy = n;
      saveTicketItems_(r, data, '');
      return { rdy: n, qty: q };
    });
  });
}

/**
 * Marks all portions of this station on a ticket as ready (done = true, "Semua siap"),
 * or sends them back to the queue (undo = true, only when nothing was delivered yet).
 */
function apiKitchenDone(token, ticketId, station, undo) {
  return run_(function () {
    station = String(station || '').toUpperCase();
    const user = requirePerm_(token, stationPerm_(station));
    return withLock_(function () {
      const rows = rowsWhere_('Kitchen_Tickets', 'Ticket_ID', String(ticketId || ''));
      if (!rows.length) throw new Error('Tiket tidak ditemukan. Muat ulang layar.');
      const r = rows[0];
      const statusCol = station === 'FOOD' ? 'Food_Status' : 'Bar_Status';
      if (!String(r[statusCol] || '')) throw new Error('Tiket ini tidak punya item untuk layar ini.');
      const data = ticketData_(r);
      if (undo && data.items.some(function (i) { return i.st === station && (Number(i.srv) || 0) > 0; })) {
        throw new Error('Sebagian sudah diantar, tidak bisa dikembalikan ke antrian.');
      }
      data.items.forEach(function (i) {
        if (i.st === station) i.rdy = undo ? 0 : (Number(i.qty) || 0);
      });
      saveTicketItems_(r, data, undo ? station : '');
      if (undo) audit_(user, 'KITCHEN_UNDO', 'Ticket', String(ticketId), { station: station });
      return true;
    });
  });
}
