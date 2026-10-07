/**
 * Purchasing.gs  (Phase 3)
 * Suppliers, purchase orders, goods receiving and direct purchases.
 *
 * Flow:
 *  1. Purchase order (PO): supplier + ingredient lines with quantity in the ingredient's
 *     purchase unit and the agreed price per purchase unit. Status DRAFT or ORDERED.
 *  2. Goods receiving: type what actually arrived and the REAL price per unit on the invoice.
 *     Stock goes up, Cost_Per_Base_Unit is updated (weighted average or last price),
 *     and recipe COGS follow automatically. Status becomes PARTIAL or RECEIVED.
 *  3. Direct purchase (market / no PO): one step that creates and receives a PO.
 */

function poStatusWord_(s) {
  return { DRAFT: 'draft', ORDERED: 'dipesan', PARTIAL: 'diterima sebagian', RECEIVED: 'diterima', CANCELLED: 'dibatalkan' }[s] || String(s).toLowerCase();
}

// ---------------- Suppliers ----------------

function suppliersList_() {
  return readTable_('Suppliers').rows.map(function (r) {
    return {
      row: r._row, id: String(r.Supplier_ID).trim(), name: String(r.Supplier_Name).trim(),
      contact: String(r.Contact_Person || ''), phone: String(r.Phone || ''), address: String(r.Address || ''),
      notes: String(r.Notes || ''),
      active: String(r.Active_Status == null ? '' : r.Active_Status).trim() === '' ? true : isTrue_(r.Active_Status)
    };
  }).filter(function (s) { return s.id && s.name; });
}

function apiGetSuppliers(token) {
  return run_(function () {
    const user = requirePerm_(token, ['suppliers.manage', 'suppliers.view', 'purchasing.view', 'purchasing.manage']);
    const totals = {};
    readTable_('Purchase_Orders').rows.forEach(function (p) {
      const sid = String(p.Supplier_ID).trim();
      const t = totals[sid] = totals[sid] || { total: 0, count: 0, last: '' };
      const rec = moneyNum_(p.Received_Total) || 0;
      if (rec > 0) { t.total += rec; t.count++; }
      const d = dateText_(p.Received_Date);
      if (d > t.last) t.last = d;
    });
    return {
      canEdit: hasPerm_(user.role, 'suppliers.manage'),
      suppliers: suppliersList_().map(function (s) {
        const t = totals[s.id] || { total: 0, count: 0, last: '' };
        return { id: s.id, name: s.name, contact: s.contact, phone: s.phone, address: s.address, notes: s.notes, active: s.active,
                 purchased: t.total, receipts: t.count, lastPurchase: t.last ? dateLabel_(t.last) : '' };
      })
    };
  });
}

function apiSaveSupplier(token, d) {
  return run_(function () {
    const user = requirePerm_(token, 'suppliers.manage');
    d = d || {};
    const name = cleanText_(d.name, 80);
    if (!name) throw new Error('Nama supplier wajib diisi.');
    return withLock_(function () {
      const list = suppliersList_();
      if (list.some(function (s) { return s.name.toLowerCase() === name.toLowerCase() && s.id !== String(d.id || ''); })) {
        throw new Error('Supplier bernama "' + name + '" sudah ada.');
      }
      const fields = { Supplier_Name: name, Contact_Person: cleanText_(d.contact, 60), Phone: cleanText_(d.phone, 30),
                       Address: cleanText_(d.address, 150), Notes: cleanText_(d.notes, 200), Active_Status: d.active !== false,
                       Updated_At: nowStamp_() };
      let id = String(d.id || '');
      if (id) {
        const old = list.filter(function (s) { return s.id === id; })[0];
        if (!old) throw new Error('Supplier tidak ditemukan.');
        updateRow_('Suppliers', old.row, fields);
        audit_(user, 'SUPPLIER_UPDATE', 'Supplier', id, { name: name });
      } else {
        id = nextId_(list.map(function (s) { return s.id; }), 'S', 3);
        fields.Supplier_ID = id;
        appendObjects_('Suppliers', [fields]);
        audit_(user, 'SUPPLIER_CREATE', 'Supplier', id, { name: name });
      }
      return { id: id };
    });
  });
}

// ---------------- Purchase orders: reading ----------------

function poList_() {
  const sup = {};
  suppliersList_().forEach(function (s) { sup[s.id] = s; });
  const ings = {};
  ingredientsList_().forEach(function (i) { ings[i.id] = i; });
  const lines = {};
  readTable_('Purchase_Order_Details').rows.forEach(function (d) {
    const id = String(d.PO_ID).trim();
    const ing = ings[String(d.Ingredient_ID).trim()];
    (lines[id] = lines[id] || []).push({
      row: d._row, lineNo: Number(d.Line_No) || 0, ingredientId: String(d.Ingredient_ID).trim(),
      name: ing ? ing.name : String(d.Ingredient_ID), unit: String(d.Unit || ''), qty: numOr_(d.Quantity, 0),
      unitPrice: moneyNum_(d.Unit_Price) || 0, lineTotal: moneyNum_(d.Line_Total) || 0,
      qtyReceived: numOr_(d.Qty_Received, 0), receivedUnitPrice: moneyNum_(d.Received_Unit_Price) || 0,
      receivedTotal: moneyNum_(d.Received_Total) || 0,
      unitToBase: numOr_(d.Unit_To_Base, ing ? ing.purchaseToBase : 1) || 1, baseUnit: ing ? ing.baseUnit : ''
    });
  });
  return readTable_('Purchase_Orders').rows.map(function (p) {
    const id = String(p.PO_ID).trim();
    const sid = String(p.Supplier_ID).trim();
    return {
      row: p._row, id: id, date: dateText_(p.PO_Date), dateLabel: dateLabel_(dateText_(p.PO_Date)), supplierId: sid,
      supplierName: sup[sid] ? sup[sid].name : sid, status: String(p.Status || '').trim().toUpperCase(),
      type: String(p.Type || 'PO').trim().toUpperCase() || 'PO', total: moneyNum_(p.Total) || 0,
      receivedTotal: moneyNum_(p.Received_Total) || 0, createdBy: String(p.Created_By || ''),
      receivedDate: dateText_(p.Received_Date), receivedBy: String(p.Received_By || ''), invoiceNo: String(p.Invoice_No || ''),
      notes: String(p.Notes || ''),
      lines: (lines[id] || []).sort(function (a, b) { return a.lineNo - b.lineNo; })
    };
  }).filter(function (p) { return p.id; });
}

function publicPo_(p) {
  const o = {};
  Object.keys(p).forEach(function (k) { if (k !== 'row') o[k] = p[k]; });
  o.lines = p.lines.map(function (l) { const x = Object.assign({}, l); delete x.row; return x; });
  return o;
}

function apiGetPurchaseOrders(token, filter) {
  return run_(function () {
    const user = requirePerm_(token, ['purchasing.view', 'purchasing.manage']);
    filter = filter || {};
    const mode = String(filter.mode || 'open');
    let list = poList_();
    let range = null;
    if (mode === 'open') list = list.filter(function (p) { return ['DRAFT', 'ORDERED', 'PARTIAL'].indexOf(p.status) >= 0; });
    else if (mode === 'receiving') list = list.filter(function (p) { return ['ORDERED', 'PARTIAL', 'DRAFT'].indexOf(p.status) >= 0; });
    else {
      range = resolveRange_(filter);
      list = list.filter(function (p) {
        const d = p.receivedDate || p.date;
        return d >= range.from && d <= range.to && ['RECEIVED', 'PARTIAL', 'CANCELLED'].indexOf(p.status) >= 0;
      });
    }
    if (filter.supplierId) list = list.filter(function (p) { return p.supplierId === String(filter.supplierId); });
    list.sort(function (a, b) { return (b.receivedDate || b.date) < (a.receivedDate || a.date) ? -1 : 1; });
    const canManage = hasPerm_(user.role, 'purchasing.manage');
    return {
      mode: mode, from: range ? range.from : '', to: range ? range.to : '', canManage: canManage,
      orders: list.slice(0, 300).map(publicPo_),
      total: list.reduce(function (s, p) { return s + (mode === 'history' ? p.receivedTotal : p.total); }, 0),
      suppliers: suppliersList_().filter(function (s) { return s.active; }).map(function (s) { return { id: s.id, name: s.name }; }),
      ingredients: canManage ? ingredientsList_().filter(function (i) { return i.active; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); })
        .map(function (i) { return { id: i.id, name: i.name, group: i.group, purchaseUnit: i.purchaseUnit, purchaseToBase: i.purchaseToBase,
                                      baseUnit: i.baseUnit, lastPrice: i.lastPrice, supplierId: i.supplierId,
                                      costPerPurchaseUnit: Math.round(i.cost * i.purchaseToBase) }; }) : []
    };
  });
}

// ---------------- Purchase orders: writing ----------------

function nextPoId_() {
  const dateKey = fmt_(new Date(), 'yyyyMMdd');
  const existing = {};
  readTable_('Purchase_Orders').rows.forEach(function (p) { existing[String(p.PO_ID).trim()] = true; });
  let n = nextSeq_('POSEQ_' + dateKey, 1);
  let id;
  do { n++; id = 'PO-' + dateKey + '-' + String(n).padStart(3, '0'); } while (existing[id]);
  PropertiesService.getScriptProperties().setProperty('POSEQ_' + dateKey, String(n));
  return id;
}

/** Checks PO lines from the phone. Returns lines with the ingredient attached. */
function checkPoLines_(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Tambahkan minimal satu bahan.');
  if (lines.length > 100) throw new Error('Baris terlalu banyak (maks. 100).');
  const ings = {};
  ingredientsList_().forEach(function (i) { ings[i.id] = i; });
  return lines.map(function (l, idx) {
    const ing = ings[String(l && l.ingredientId || '')];
    if (!ing || !ing.active) throw new Error('Baris ' + (idx + 1) + ': pilih bahan.');
    const qty = Number(l.qty);
    if (!isFinite(qty) || qty <= 0 || qty > 1000000) throw new Error(ing.name + ': jumlah harus di atas 0.');
    const price = Number(l.unitPrice);
    if (!Number.isInteger(price) || price < 0 || price > 1000000000) throw new Error(ing.name + ': harga harus angka Rupiah bulat.');
    return { ing: ing, qty: round4_(qty), unitPrice: price, total: Math.round(qty * price) };
  });
}

/** Creates or replaces a PO (not yet received). Call inside withLock_. */
function savePo_(user, d, type) {
  const sid = String(d.supplierId || '');
  if (!suppliersList_().some(function (s) { return s.id === sid && s.active; })) throw new Error('Pilih supplier.');
  const date = isDateStr_(d.date) ? d.date : todayStr_();
  const status = String(d.status || 'ORDERED').toUpperCase();
  if (['DRAFT', 'ORDERED'].indexOf(status) < 0) throw new Error('Status tidak dikenal.');
  const lines = checkPoLines_(d.lines);
  const total = lines.reduce(function (s, l) { return s + l.total; }, 0);
  const stamp = nowStamp_();
  const header = { PO_Date: date, Supplier_ID: sid, Status: status, Total: total, Notes: cleanText_(d.notes, 200),
                   Type: type || 'PO', Updated_At: stamp };
  let id = String(d.poId || '');
  if (id) {
    const old = poList_().filter(function (p) { return p.id === id; })[0];
    if (!old) throw new Error('PO tidak ditemukan.');
    if (['DRAFT', 'ORDERED'].indexOf(old.status) < 0) throw new Error('PO ini sudah ' + poStatusWord_(old.status) + ' dan tidak bisa diubah lagi.');
    updateRow_('Purchase_Orders', old.row, header);
    deleteRowsWhere_('Purchase_Order_Details', 'PO_ID', id);
  } else {
    id = nextPoId_();
    header.PO_ID = id;
    header.Created_By = user.name;
    header.Received_Total = 0;
    appendObjects_('Purchase_Orders', [header]);
  }
  appendObjects_('Purchase_Order_Details', lines.map(function (l, i) {
    return { PO_ID: id, Line_No: i + 1, Ingredient_ID: l.ing.id, Quantity: l.qty, Unit: l.ing.purchaseUnit, Unit_Price: l.unitPrice,
             Line_Total: l.total, Qty_Received: 0, Received_Unit_Price: '', Received_Total: 0, Unit_To_Base: l.ing.purchaseToBase };
  }));
  return { id: id, total: total, lines: lines.length };
}

/** Receives goods on a PO. Call inside withLock_. */
function receivePo_(user, d) {
  const po = poList_().filter(function (p) { return p.id === String(d.poId || ''); })[0];
  if (!po) throw new Error('PO tidak ditemukan.');
  if (['DRAFT', 'ORDERED', 'PARTIAL'].indexOf(po.status) < 0) throw new Error('PO ini sudah ' + poStatusWord_(po.status) + '.');
  const input = {};
  (Array.isArray(d.lines) ? d.lines : []).forEach(function (l) { input[Number(l && l.lineNo)] = l; });
  const ings = {};
  ingredientsList_().forEach(function (i) { ings[i.id] = i; });
  const method = String(getSettingsMap_().Costing_Method || 'AVERAGE').toUpperCase();
  const state = {};   // running stock & cost per ingredient while we go through the lines
  const moves = [];
  const costUpdates = {};
  let received = 0;
  const invoice = cleanText_(d.invoiceNo, 40);

  po.lines.forEach(function (l) {
    const inp = input[l.lineNo];
    if (!inp) return;
    const qty = Number(inp.qty);
    if (!qty) return;
    if (!isFinite(qty) || qty < 0 || qty > 1000000) throw new Error(l.name + ': jumlah diterima tidak valid.');
    const price = Number(inp.unitPrice);
    if (!Number.isInteger(price) || price < 0 || price > 1000000000) throw new Error(l.name + ': harga harus angka Rupiah bulat.');
    const ing = ings[l.ingredientId];
    if (!ing) throw new Error('Bahan ' + l.ingredientId + ' sudah tidak ada.');
    const factor = l.unitToBase > 0 ? l.unitToBase : ing.purchaseToBase;
    const baseQty = qty * factor;
    const costPerBase = price / factor;
    const st = state[ing.id] = state[ing.id] || { stock: ing.stock, cost: ing.cost };
    if (method === 'LAST' || st.stock <= 0) st.cost = costPerBase;
    else st.cost = (st.stock * st.cost + baseQty * costPerBase) / (st.stock + baseQty);
    st.stock += baseQty;
    costUpdates[ing.id] = { cost: st.cost, lastPrice: Math.round(price * ing.purchaseToBase / factor) };
    moves.push({ ing: ing, type: 'PURCHASE', qty: qty, unit: l.unit, baseQty: baseQty, unitCost: costPerBase, ref: po.id,
                 supplierId: po.supplierId, notes: invoice ? 'Invoice ' + invoice : '' });
    const lineTotal = Math.round(qty * price);
    received += lineTotal;
    updateRow_('Purchase_Order_Details', l.row, { Qty_Received: round4_(l.qtyReceived + qty), Received_Unit_Price: price,
                                                   Received_Total: l.receivedTotal + lineTotal });
    l.qtyReceived += qty;
  });
  if (!moves.length && !d.close) throw new Error('Isi jumlah barang yang datang, minimal untuk satu baris.');
  if (!moves.length && d.close && po.receivedTotal === 0) throw new Error('Belum ada barang yang diterima untuk PO ini. Pakai "Batalkan PO" saja.');

  applyMovements_(moves, user, costUpdates);
  const complete = po.lines.every(function (l) { return l.qtyReceived >= l.qty - 1e-9; });
  const status = complete || d.close ? 'RECEIVED' : 'PARTIAL';
  const recDate = isDateStr_(d.date) ? d.date : todayStr_();
  updateRow_('Purchase_Orders', po.row, {
    Status: status, Received_Total: po.receivedTotal + received, Received_Date: recDate, Received_By: user.name,
    Invoice_No: invoice ? (po.invoiceNo ? po.invoiceNo + ', ' + invoice : invoice) : po.invoiceNo, Updated_At: nowStamp_()
  });
  if (moves.length) refreshProductCosts_();
  audit_(user, 'PURCHASE_RECEIVE', 'PurchaseOrder', po.id, { supplier: po.supplierName, lines: moves.length, total: received, status: status, invoice: invoice });
  return { id: po.id, status: status, received: received };
}

function apiSavePurchaseOrder(token, d) {
  return run_(function () {
    const user = requirePerm_(token, 'purchasing.manage');
    return withLock_(function () {
      const r = savePo_(user, d || {}, 'PO');
      audit_(user, d && d.poId ? 'PO_UPDATE' : 'PO_CREATE', 'PurchaseOrder', r.id, { total: r.total, lines: r.lines, status: d.status });
      return r;
    });
  });
}

function apiReceivePurchaseOrder(token, d) {
  return run_(function () {
    const user = requirePerm_(token, 'purchasing.manage');
    return withLock_(function () { return receivePo_(user, d || {}); });
  });
}

/** Market / no-PO purchase: creates the PO and receives everything in one step. */
function apiDirectPurchase(token, d) {
  return run_(function () {
    const user = requirePerm_(token, 'purchasing.manage');
    d = d || {};
    return withLock_(function () {
      const r = savePo_(user, { supplierId: d.supplierId, date: d.date, notes: d.notes, status: 'ORDERED', lines: d.lines }, 'DIRECT');
      const po = poList_().filter(function (p) { return p.id === r.id; })[0];
      return receivePo_(user, { poId: r.id, invoiceNo: d.invoiceNo, date: d.date,
        lines: po.lines.map(function (l) { return { lineNo: l.lineNo, qty: l.qty, unitPrice: l.unitPrice }; }) });
    });
  });
}

function apiCancelPurchaseOrder(token, poId) {
  return run_(function () {
    const user = requirePerm_(token, 'purchasing.manage');
    return withLock_(function () {
      const po = poList_().filter(function (p) { return p.id === String(poId || ''); })[0];
      if (!po) throw new Error('PO tidak ditemukan.');
      if (po.lines.some(function (l) { return l.qtyReceived > 0; })) throw new Error('Sudah ada barang yang diterima untuk PO ini, jadi tidak bisa dibatalkan. Tutup PO-nya dari Penerimaan Barang.');
      if (['DRAFT', 'ORDERED'].indexOf(po.status) < 0) throw new Error('PO ini sudah ' + poStatusWord_(po.status) + '.');
      updateRow_('Purchase_Orders', po.row, { Status: 'CANCELLED', Updated_At: nowStamp_() });
      audit_(user, 'PO_CANCEL', 'PurchaseOrder', po.id, { supplier: po.supplierName, total: po.total });
      return true;
    });
  });
}
