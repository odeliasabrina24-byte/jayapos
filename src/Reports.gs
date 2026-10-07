/**
 * Reports.gs
 * Sales History, receipts, the Dashboard and the owner reports (Phase 4):
 * sales, COGS, profitability, purchasing and inventory.
 *
 * Definitions used everywhere:
 *  - Gross sales  = sum of item prices (Subtotal)
 *  - Net sales    = Gross sales - discounts   (service and tax are NOT revenue here)
 *  - COGS         = quantity x Unit_Cost saved at the moment of sale (recipe cost, or Products.Cost)
 *  - Gross profit = Net sales - COGS;  margin = Gross profit / Net sales
 *  - Per-product revenue is after item discounts, before the bill discount.
 *  - Voided transactions (Status VOID) are left out everywhere; the Sales report shows how many.
 */

function resolveRange_(filter) {
  filter = filter || {};
  const today = todayStr_();
  const range = String(filter.range || 'today');
  let from, to;
  if (range === 'today') { from = today; to = today; }
  else if (range === 'yesterday') { from = addDays_(today, -1); to = from; }
  else if (range === 'week') { from = addDays_(today, -((dayOfWeek_(today) + 6) % 7)); to = today; } // week starts Monday
  else if (range === 'month') { from = today.slice(0, 8) + '01'; to = today; }
  else if (range === 'custom') {
    if (!isDateStr_(filter.from)) throw new Error('Pilih tanggal mulai.');
    from = filter.from;
    to = isDateStr_(filter.to) ? filter.to : filter.from;
    if (from > to) { const x = from; from = to; to = x; }
  } else {
    throw new Error('Filter tanggal tidak dikenal.');
  }
  return { from: from, to: to };
}

/**
 * Reads only rows from `from` onwards (sheets are written in date order), so reports stay fast
 * as the sheets grow. Returns row objects like readTable_.
 */
function readSince_(name, dateHeader, from) {
  const sh = getSheet_(name);
  const headers = getHeaders_(sh);
  const c = headers.indexOf(dateHeader);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  if (c < 0) return readTable_(name).rows;
  const dates = sh.getRange(2, c + 1, lastRow - 1, 1).getValues();
  let i = 0;
  while (i < dates.length && dateText_(dates[i][0]) < from) i++;
  if (i >= dates.length) return [];
  return sh.getRange(2 + i, 1, lastRow - 1 - i, headers.length).getValues().map(function (r, k) {
    const o = { _row: 2 + i + k };
    headers.forEach(function (h, j) { if (h) o[h] = r[j]; });
    return o;
  }).filter(function (o) { return o[headers[0]] !== '' && o[headers[0]] !== null; });
}

/** Completed sales and their lines between two dates. */
function salesData_(from, to) {
  const all = readSince_('Transactions', 'Date', from).map(txFromRow_)
    .filter(function (t) { return t.id && t.date >= from && t.date <= to; });
  const txs = all.filter(function (t) { return t.status === 'COMPLETED'; });
  const voids = all.filter(function (t) { return t.status === 'VOID'; });
  const ids = {};
  txs.forEach(function (t) { ids[t.id] = t; });
  const lines = readSince_('Transaction_Details', 'Date', from).filter(function (d) { return ids[String(d.Transaction_ID)]; })
    .map(function (d) {
      const qty = Number(d.Quantity) || 0;
      const gross = moneyNum_(d.Total) || 0;
      const net = moneyNum_(d.Net_Total);
      const unitCost = moneyNum_(d.Unit_Cost) || 0;
      const t = ids[String(d.Transaction_ID)];
      return { txId: t.id, date: t.date, productId: String(d.Product_ID), name: String(d.Product_Name),
               category: String(d.Category || 'Other'), qty: qty, revenue: isFinite(net) ? net : gross,
               unitCost: unitCost, cogs: unitCost * qty };
    });
  return { txs: txs, lines: lines, voids: voids };
}

/**
 * Money received per payment method. A bill split equally over QRIS + cash counts in both
 * (from the Payments sheet); sales saved before v3 use the method on the transaction.
 */
function paymentsByMethod_(txs, from) {
  const ids = {};
  txs.forEach(function (t) { ids[t.id] = true; });
  const got = {};
  try {
    readSince_('Payments', 'Date', from).forEach(function (p) {
      const id = String(p.Transaction_ID);
      if (!ids[id]) return;
      (got[id] = got[id] || []).push({ method: String(p.Method), amount: moneyNum_(p.Amount) || 0 });
    });
  } catch (e) { /* no Payments sheet yet */ }
  const list = [];
  txs.forEach(function (t) {
    (got[t.id] || [{ method: t.method, amount: t.total }]).forEach(function (p) { list.push(p); });
  });
  return groupSum_(list, function (p) { return p.method; },
    function (p) { return { method: p.method, label: methodLabel_(p.method), total: 0, count: 0 }; },
    function (m, p) { m.total += p.amount; m.count++; }).sort(function (a, b) { return b.total - a.total; });
}

/** "yyyy-MM-dd HH:mm:ss" (Bali time, WITA = UTC+8) -> milliseconds. */
function stampMs_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0));
}

/**
 * How long dine-in guests stayed: from opening the table to this payment (minutes).
 * Sales saved before v3.0.1 have no Duration_Min; it is worked out from the table bill's opening time.
 */
function fillDurations_(txs) {
  const need = txs.filter(function (t) { return t.orderType === 'DINE_IN' && t.durationMin === null && t.orderId; });
  if (!need.length) return txs;
  const opened = {};
  try {
    readRecentRows_('Open_Orders', 3000).forEach(function (r) {
      const ms = Number(r.Opened_Ms) || stampMs_(cellText_(r.Opened_At));
      if (r.Order_ID && isFinite(ms)) opened[String(r.Order_ID).trim()] = ms;
    });
  } catch (e) { return txs; }
  need.forEach(function (t) {
    const o = opened[t.orderId];
    const paid = stampMs_(t.stamp);
    if (o && isFinite(paid) && paid >= o - 60000) t.durationMin = Math.max(0, Math.round((paid - o) / 60000));   // the paid time has whole seconds only
  });
  return txs;
}

/** Average stay per table bill (a split bill counts once, until its last payment). */
function avgDuration_(txs) {
  const byOrder = {};
  txs.forEach(function (t) {
    if (t.orderType !== 'DINE_IN' || t.durationMin === null) return;
    const k = t.orderId || t.id;
    byOrder[k] = Math.max(byOrder[k] || 0, t.durationMin);
  });
  const v = Object.keys(byOrder).map(function (k) { return byOrder[k]; });
  return v.length ? { avg: Math.round(v.reduce(function (a, b) { return a + b; }, 0) / v.length), max: Math.max.apply(null, v), bills: v.length } : null;
}

function daysBetween_(from, to) {
  const out = [];
  let d = from;
  while (d <= to && out.length < 400) { out.push(d); d = addDays_(d, 1); }
  return out;
}

function groupSum_(rows, keyFn, init, addFn) {
  const map = {};
  rows.forEach(function (r) {
    const k = keyFn(r);
    if (!map[k]) map[k] = init(r);
    addFn(map[k], r);
  });
  return Object.keys(map).map(function (k) { return map[k]; });
}

function pct_(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }

/** Earliest date this user may see. Cashiers only see recent days. */
function historyStart_(user) {
  if (hasPerm_(user.role, 'history.view_all')) return '0000-00-00';
  const days = Math.max(1, parseInt(getSettingsMap_().Cashier_History_Days, 10) || 2);
  return addDays_(todayStr_(), -(days - 1));
}

function apiGetSalesHistory(token, filter) {
  return run_(function () {
    const user = requirePerm_(token, ['history.view_all', 'history.view_recent']);
    const r = resolveRange_(filter);
    const earliest = historyStart_(user);
    let limited = false;
    if (r.from < earliest) { r.from = earliest; limited = true; }
    const showTotals = hasPerm_(user.role, 'history.view_all');
    if (r.to < r.from) return { from: r.from, to: r.to, limited: true, count: 0, total: null, rows: [], truncated: false };

    const rows = readSince_('Transactions', 'Date', r.from).map(txFromRow_)
      .filter(function (t) { return t.id && t.date >= r.from && t.date <= r.to; })
      .sort(function (a, b) { return a.stamp < b.stamp ? 1 : (a.stamp > b.stamp ? -1 : 0); });
    fillDurations_(rows.slice(0, 500));
    const total = rows.filter(function (t) { return t.status === 'COMPLETED'; })
      .reduce(function (s, t) { return s + t.total; }, 0);

    return {
      from: r.from, to: r.to, limited: limited, count: rows.length,
      total: showTotals ? total : null,
      rows: rows.slice(0, 500).map(function (t) {
        return { id: t.id, date: t.date, dateLabel: t.dateLabel, time: t.time, cashier: t.cashier,
                 total: t.total, methodLabel: t.methodLabel, status: t.status,
                 orderType: t.orderType, tableName: t.tableName, pax: t.pax, guestName: t.guestName, splitInfo: t.splitInfo,
                 durationMin: t.durationMin };
      }),
      truncated: rows.length > 500
    };
  });
}

function apiGetReceipt(token, txId) {
  return run_(function () {
    const user = requirePerm_(token, 'receipt.view');
    txId = String(txId || '').trim();
    if (!/^[A-Z]{1,5}-\d{8}-\d{4,}$/.test(txId)) throw new Error('Nomor transaksi tidak valid.');
    const r = buildReceipt_(txId);
    if (r.date < historyStart_(user)) throw jayaError_('Akses ditolak. Transaksi ini terlalu lama untuk role Anda.', 'DENIED');
    r.canVoid = r.status === 'COMPLETED' && hasPerm_(user.role, 'pos.void') && r.date >= voidStart_(user);
    return r;
  });
}

function apiGetDashboard(token, filter) {
  return run_(function () {
    const user = requirePerm_(token, 'dashboard.view');
    const r = resolveRange_(filter);
    const d = salesData_(r.from, r.to);
    const txs = d.txs;
    const sum = function (f) { return txs.reduce(function (s, t) { return s + f(t); }, 0); };
    const sales = sum(function (t) { return t.total; });
    const net = sum(function (t) { return t.subtotal - t.discount; });
    const cogs = Math.round(d.lines.reduce(function (s, l) { return s + l.cogs; }, 0));
    const methods = paymentsByMethod_(txs, r.from);
    const top = groupSum_(d.lines, function (l) { return l.productId; },
      function (l) { return { id: l.productId, name: l.name, qty: 0, sales: 0 }; },
      function (p, l) { p.qty += l.qty; p.sales += l.revenue; })
      .sort(function (a, b) { return b.qty - a.qty || b.sales - a.sales; }).slice(0, 10);
    const dine = txs.filter(function (t) { return t.orderType === 'DINE_IN'; });
    const days = daysBetween_(r.from, r.to);
    const byDay = days.length > 1 ? days.map(function (day) {
      const dt = txs.filter(function (t) { return t.date === day; });
      const dn = dt.reduce(function (s, t) { return s + t.subtotal - t.discount; }, 0);
      const dc = Math.round(d.lines.filter(function (l) { return l.date === day; }).reduce(function (s, l) { return s + l.cogs; }, 0));
      return { date: day, label: dateLabel_(day).slice(0, 6), net: dn, gp: dn - dc, count: dt.length };
    }) : [];
    const s = getSettingsMap_();
    const showProfit = hasPerm_(user.role, 'reports.view');
    return {
      from: r.from, to: r.to,
      sales: sales,
      count: txs.length,
      average: txs.length ? Math.round(sales / txs.length) : 0,
      service: sum(function (t) { return t.service; }),
      tax: sum(function (t) { return t.tax; }),
      serviceLabel: s.Service_Label || 'Service',
      taxLabel: s.Tax_Label || 'Tax',
      dineIn: dine.length,
      guests: dine.reduce(function (a, t) { return a + t.pax; }, 0),
      takeaway: txs.length - dine.length,
      net: net,
      cogs: showProfit ? cogs : null,
      grossProfit: showProfit ? net - cogs : null,
      margin: showProfit ? pct_(net - cogs, net) : null,
      byDay: byDay,
      byMethod: methods,
      topProducts: top
    };
  });
}

// ---------------- Phase 4 reports ----------------

function apiGetReport(token, type, filter) {
  return run_(function () {
    type = String(type || '');
    requirePerm_(token, type === 'inventory' ? ['inventory.view'] : ['reports.view']);
    const r = resolveRange_(filter);
    if (type === 'sales') return salesReport_(r);
    if (type === 'cogs') return cogsReport_(r);
    if (type === 'profit') return profitReport_(r);
    if (type === 'purchasing') return purchasingReport_(r);
    if (type === 'inventory') return inventoryReport_(r);
    throw new Error('Laporan tidak dikenal.');
  });
}

function salesReport_(r) {
  const d = salesData_(r.from, r.to);
  const txs = fillDurations_(d.txs);
  const sum = function (f) { return txs.reduce(function (s, t) { return s + f(t); }, 0); };
  const gross = sum(function (t) { return t.subtotal; });
  const discount = sum(function (t) { return t.discount; });
  const itemDiscount = sum(function (t) { return t.itemDiscount; });
  const collected = sum(function (t) { return t.total; });
  const byDay = daysBetween_(r.from, r.to).map(function (day) {
    const dt = txs.filter(function (t) { return t.date === day; });
    return { date: day, label: dateLabel_(day), net: dt.reduce(function (s, t) { return s + t.subtotal - t.discount; }, 0), count: dt.length };
  });
  const byHour = groupSum_(txs, function (t) { return t.time.slice(0, 2); },
    function (t) { return { hour: t.time.slice(0, 2), net: 0, count: 0 }; },
    function (h, t) { h.net += t.subtotal - t.discount; h.count++; }).sort(function (a, b) { return a.hour < b.hour ? -1 : 1; });
  const byPayment = paymentsByMethod_(txs, r.from);
  const byType = groupSum_(txs, function (t) { return t.orderType; },
    function (t) { return { type: t.orderType === 'DINE_IN' ? 'Makan di tempat' : 'Takeaway', count: 0, net: 0, guests: 0 }; },
    function (m, t) { m.count++; m.net += t.subtotal - t.discount; m.guests += t.pax; });
  const products = groupSum_(d.lines, function (l) { return l.productId; },
    function (l) { return { name: l.name, category: l.category, qty: 0, revenue: 0 }; },
    function (p, l) { p.qty += l.qty; p.revenue += l.revenue; }).sort(function (a, b) { return b.revenue - a.revenue; });
  const categories = groupSum_(d.lines, function (l) { return l.category; },
    function (l) { return { name: l.category, qty: 0, revenue: 0 }; },
    function (c, l) { c.qty += l.qty; c.revenue += l.revenue; }).sort(function (a, b) { return b.revenue - a.revenue; });
  return {
    type: 'sales', from: r.from, to: r.to, count: txs.length, gross: gross, discount: discount, net: gross - discount,
    itemDiscount: itemDiscount, billDiscount: discount - itemDiscount,
    service: sum(function (t) { return t.service; }), tax: sum(function (t) { return t.tax; }),
    rounding: sum(function (t) { return t.rounding; }), collected: collected,
    voidCount: d.voids.length, voidTotal: d.voids.reduce(function (s, t) { return s + t.total; }, 0),
    voids: d.voids.map(function (t) { return { id: t.id, date: t.dateLabel, total: t.total, by: t.voidBy, reason: t.voidReason, cashier: t.cashier }; }),
    average: txs.length ? Math.round(collected / txs.length) : 0,
    stay: avgDuration_(txs),
    byDay: byDay, byHour: byHour, byPayment: byPayment, byType: byType, products: products.slice(0, 100), categories: categories
  };
}

function cogsReport_(r) {
  const d = salesData_(r.from, r.to);
  const net = d.txs.reduce(function (s, t) { return s + t.subtotal - t.discount; }, 0);
  const cogs = Math.round(d.lines.reduce(function (s, l) { return s + l.cogs; }, 0));
  const products = groupSum_(d.lines, function (l) { return l.productId; },
    function (l) { return { name: l.name, category: l.category, qty: 0, revenue: 0, cogs: 0, missing: false }; },
    function (p, l) { p.qty += l.qty; p.revenue += l.revenue; p.cogs += l.cogs; if (!l.unitCost) p.missing = true; })
    .map(function (p) { p.cogs = Math.round(p.cogs); p.unitCost = p.qty ? Math.round(p.cogs / p.qty) : 0; p.costPct = pct_(p.cogs, p.revenue); return p; })
    .sort(function (a, b) { return b.cogs - a.cogs; });
  const categories = groupSum_(products, function (p) { return p.category; },
    function (p) { return { name: p.category, revenue: 0, cogs: 0 }; },
    function (c, p) { c.revenue += p.revenue; c.cogs += p.cogs; })
    .map(function (c) { c.costPct = pct_(c.cogs, c.revenue); return c; }).sort(function (a, b) { return b.cogs - a.cogs; });
  return {
    type: 'cogs', from: r.from, to: r.to, net: net, cogs: cogs, cogsPct: pct_(cogs, net), products: products.slice(0, 100),
    categories: categories, missing: products.filter(function (p) { return p.missing; }).map(function (p) { return p.name; })
  };
}

function profitReport_(r) {
  const d = salesData_(r.from, r.to);
  const net = d.txs.reduce(function (s, t) { return s + t.subtotal - t.discount; }, 0);
  const cogs = Math.round(d.lines.reduce(function (s, l) { return s + l.cogs; }, 0));
  const byDay = daysBetween_(r.from, r.to).map(function (day) {
    const dn = d.txs.filter(function (t) { return t.date === day; }).reduce(function (s, t) { return s + t.subtotal - t.discount; }, 0);
    const dc = Math.round(d.lines.filter(function (l) { return l.date === day; }).reduce(function (s, l) { return s + l.cogs; }, 0));
    return { date: day, label: dateLabel_(day), net: dn, cogs: dc, gp: dn - dc };
  });
  const products = groupSum_(d.lines, function (l) { return l.productId; },
    function (l) { return { name: l.name, category: l.category, qty: 0, revenue: 0, cogs: 0 }; },
    function (p, l) { p.qty += l.qty; p.revenue += l.revenue; p.cogs += l.cogs; })
    .map(function (p) { p.cogs = Math.round(p.cogs); p.gp = p.revenue - p.cogs; p.margin = pct_(p.gp, p.revenue); return p; })
    .sort(function (a, b) { return b.gp - a.gp; });
  const categories = groupSum_(products, function (p) { return p.category; },
    function (p) { return { name: p.category, revenue: 0, cogs: 0, gp: 0 }; },
    function (c, p) { c.revenue += p.revenue; c.cogs += p.cogs; c.gp += p.gp; })
    .map(function (c) { c.margin = pct_(c.gp, c.revenue); return c; }).sort(function (a, b) { return b.gp - a.gp; });
  return {
    type: 'profit', from: r.from, to: r.to, net: net, cogs: cogs, gp: net - cogs, margin: pct_(net - cogs, net),
    discount: d.txs.reduce(function (s, t) { return s + t.discount; }, 0),
    byDay: byDay, products: products.slice(0, 100), categories: categories
  };
}

function purchasingReport_(r) {
  const sup = {};
  suppliersList_().forEach(function (s) { sup[s.id] = s.name; });
  const moves = readSince_('Inventory_Movements', 'Date', r.from).filter(function (m) {
    const d = dateText_(m.Date);
    return String(m.Movement_Type) === 'PURCHASE' && d >= r.from && d <= r.to;
  });
  const total = moves.reduce(function (s, m) { return s + (moneyNum_(m.Total_Cost) || 0); }, 0);
  const bySupplier = groupSum_(moves, function (m) { return String(m.Supplier_ID); },
    function (m) { return { name: sup[String(m.Supplier_ID)] || String(m.Supplier_ID || 'Tidak diketahui'), total: 0, refs: {} }; },
    function (s, m) { s.total += moneyNum_(m.Total_Cost) || 0; s.refs[String(m.Reference_ID)] = true; })
    .map(function (s) { return { name: s.name, total: s.total, receipts: Object.keys(s.refs).length }; })
    .sort(function (a, b) { return b.total - a.total; });
  const byIngredient = groupSum_(moves, function (m) { return String(m.Ingredient_ID); },
    function (m) { return { name: String(m.Ingredient_Name || m.Ingredient_ID), baseQty: 0, total: 0, unit: '' }; },
    function (i, m) { i.baseQty += numOr_(m.Quantity_Base, 0); i.total += moneyNum_(m.Total_Cost) || 0; })
    .sort(function (a, b) { return b.total - a.total; });
  const ings = {};
  ingredientsList_().forEach(function (i) { ings[i.name] = i; });
  byIngredient.forEach(function (i) {
    const ing = ings[i.name];
    i.unit = ing ? ing.baseUnit : '';
    i.baseQty = round4_(i.baseQty);
    i.avgPerPurchaseUnit = ing && i.baseQty ? Math.round(i.total / i.baseQty * ing.purchaseToBase) : 0;
    i.purchaseUnit = ing ? ing.purchaseUnit : '';
  });
  const receipts = groupSum_(moves, function (m) { return String(m.Reference_ID) + '|' + cellText_(m.Timestamp) + '|' + String(m.Notes || ''); },
    function (m) { return { po: String(m.Reference_ID), date: dateLabel_(dateText_(m.Date)), supplier: sup[String(m.Supplier_ID)] || '', total: 0, lines: 0 }; },
    function (x, m) { x.total += moneyNum_(m.Total_Cost) || 0; x.lines++; }).reverse();
  const open = poList_().filter(function (p) { return p.status === 'ORDERED' || p.status === 'PARTIAL'; });
  return {
    type: 'purchasing', from: r.from, to: r.to, total: total, bySupplier: bySupplier, byIngredient: byIngredient.slice(0, 100),
    receipts: receipts.slice(0, 100),
    openOrders: open.length,
    openValue: open.reduce(function (s, p) {
      return s + p.lines.reduce(function (a, l) { return a + Math.max(0, l.qty - l.qtyReceived) * l.unitPrice; }, 0);
    }, 0)
  };
}

function inventoryReport_(r) {
  const ings = ingredientsList_().filter(function (i) { return i.active; });
  const moves = readSince_('Inventory_Movements', 'Date', r.from).filter(function (m) {
    const d = dateText_(m.Date);
    return d >= r.from && d <= r.to;
  });
  const mv = {};
  moves.forEach(function (m) {
    const id = String(m.Ingredient_ID);
    const x = mv[id] = mv[id] || { PURCHASE: 0, SALE: 0, VOID: 0, WASTE: 0, ADJUST: 0, OPENING: 0, saleCost: 0, wasteCost: 0 };
    const t = String(m.Movement_Type);
    x[t] = (x[t] || 0) + numOr_(m.Quantity_Base, 0);
    if (t === 'SALE' || t === 'VOID') x.saleCost += -(moneyNum_(m.Total_Cost) || 0);
    if (t === 'WASTE') x.wasteCost += -(moneyNum_(m.Total_Cost) || 0);
  });
  const rows = ings.map(function (i) {
    const x = mv[i.id] || { PURCHASE: 0, SALE: 0, VOID: 0, WASTE: 0, ADJUST: 0, OPENING: 0, saleCost: 0, wasteCost: 0 };
    return {
      name: i.name, group: i.group, unit: i.baseUnit, stock: round4_(i.stock), minStock: i.minStock,
      costPerPurchaseUnit: Math.round(i.cost * i.purchaseToBase), purchaseUnit: i.purchaseUnit,
      value: Math.round(Math.max(0, i.stock) * i.cost), low: i.minStock > 0 && i.stock < i.minStock, negative: i.stock < 0,
      purchased: round4_(x.PURCHASE), used: round4_(-(x.SALE + x.VOID)), wasted: round4_(-x.WASTE), adjusted: round4_(x.ADJUST + x.OPENING),
      usedCost: Math.round(x.saleCost), wasteCost: Math.round(x.wasteCost)
    };
  }).sort(function (a, b) { return b.value - a.value; });
  const byGroup = groupSum_(rows, function (x) { return x.group; },
    function (x) { return { name: x.group, value: 0, items: 0 }; },
    function (g, x) { g.value += x.value; g.items++; });
  return {
    type: 'inventory', from: r.from, to: r.to,
    totalValue: rows.reduce(function (s, x) { return s + x.value; }, 0),
    usedCost: rows.reduce(function (s, x) { return s + x.usedCost; }, 0),
    wasteCost: rows.reduce(function (s, x) { return s + x.wasteCost; }, 0),
    lowCount: rows.filter(function (x) { return x.low; }).length,
    byGroup: byGroup, rows: rows
  };
}
