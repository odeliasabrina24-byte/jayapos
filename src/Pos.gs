/**
 * Pos.gs
 * Menu for the cashier, totals (item discount, bill discount, service, PB1, cash rounding),
 * split payments and saving a completed order.
 *
 * How the total is calculated (the phone shows the same numbers, the server checks them):
 *   line gross     = price x qty
 *   item discount  = % of the line, or a Rupiah amount for the whole line
 *   items net      = sum of (line gross - item discount)
 *   bill discount  = % of items net, or a Rupiah amount
 *   base           = items net - bill discount
 *   service        = base x Service_Percent         (if ticked)
 *   tax (PB1)      = (base + service) x Tax_Percent (if ticked)
 *   payment parts  = 1 part normally; "bagi rata" N = N equal parts (the last part takes the leftover Rupiah)
 *   rounding       = per part, only for CASH parts: rounded to Cash_Rounding (e.g. 1000)
 *   grand total    = base + service + tax + rounding of all parts
 *
 * Order lines: every line has its own id (lid) and an optional note for the kitchen ("Pedas", "Es pisah").
 * The same product can appear on several lines (different notes, or ordered in a later round).
 *
 * Safety rules in apiCompleteOrder:
 *  - Prices come from the Products sheet, never from the phone.
 *  - Discounts, service, tax and rounding are recalculated on the server.
 *  - If the total on the phone differs from the server's total, the order is refused.
 *  - A table bill is paid from the lines SAVED on the bill (the phone only says which lines / how many).
 *  - A lock makes sure two phones never get the same transaction number.
 *  - Each order carries a unique reference from the phone. If the same order is
 *    sent twice (e.g. internet dropped and cashier pressed again), it is saved ONCE.
 *  - When Require_Shift is TRUE, money can only be taken while a cash shift is open.
 */

/** Turns a Google Drive share link or file ID into a picture link that works in <img>. */
function normalizeImageUrl_(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  let m = s.match(/\/file\/d\/([A-Za-z0-9_-]{20,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m) return 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w600';
  if (/^[A-Za-z0-9_-]{25,}$/.test(s)) return 'https://drive.google.com/thumbnail?id=' + s + '&sz=w600';
  if (/^https:\/\//i.test(s)) return s;
  return '';
}

function getActiveProducts_() {
  return readTable_('Products').rows.map(function (r) {
    const cost = moneyNum_(r.Cost);
    return {
      id: String(r.Product_ID).trim(),
      name: String(r.Product_Name).trim(),
      category: String(r.Category).trim() || 'Other',
      price: moneyNum_(r.Selling_Price),
      cost: isFinite(cost) ? cost : 0,
      active: isTrue_(r.Active),
      recipeGroup: String(r.Recipe_Group || '').trim().toUpperCase() || 'NONE',
      image: normalizeImageUrl_(r.Image_URL),
      row: r._row,
      soldOut: isTrue_(r.Sold_Out), soldOutBy: String(r.Sold_Out_By || ''), soldOutAt: cellText_(r.Sold_Out_At)
    };
  }).filter(function (p) { return p.active && p.id && p.name && isFinite(p.price) && p.price >= 0; });
}

function productMap_() {
  const m = {};
  getActiveProducts_().forEach(function (p) { m[p.id] = p; });
  return m;
}

function categoryOrder_() { return listSetting_('Category_Order'); }

function chargeSettings_() {
  const s = getSettingsMap_();
  const mode = String(s.Cash_Rounding_Mode || 'NEAREST').toUpperCase();
  return {
    servicePct: Math.max(0, Math.min(50, numOr_(s.Service_Percent, 0))),
    serviceLabel: s.Service_Label || 'Service',
    serviceOnTakeaway: isTrue_(s.Service_On_Takeaway),
    taxPct: Math.max(0, Math.min(50, numOr_(s.Tax_Percent, 0))),
    taxLabel: s.Tax_Label || 'PB1',
    taxOnTakeaway: String(s.Tax_On_Takeaway == null ? '' : s.Tax_On_Takeaway).trim() === '' ? true : isTrue_(s.Tax_On_Takeaway),
    cashRounding: Math.max(0, Math.round(numOr_(s.Cash_Rounding, 0))),
    roundingMode: ['NEAREST', 'DOWN', 'UP'].indexOf(mode) >= 0 ? mode : 'NEAREST'
  };
}

/** A discount from the phone: { type: 'PCT' | 'AMT', value }. Returns null for "no discount". */
function readDiscount_(d, what) {
  if (!d || typeof d !== 'object') return null;
  const type = String(d.type || '').toUpperCase();
  const value = Number(d.value);
  if (!value) return null;
  if (type === 'PCT') {
    if (!isFinite(value) || value <= 0 || value > 100) throw new Error('Diskon ' + what + ' dalam % harus antara 0 dan 100.');
    return { type: 'PCT', value: Math.round(value * 100) / 100 };
  }
  if (type === 'AMT') {
    if (!Number.isInteger(value) || value <= 0) throw new Error('Diskon ' + what + ' dalam Rupiah harus angka bulat.');
    return { type: 'AMT', value: value };
  }
  throw new Error('Jenis diskon ' + what + ' tidak dikenal.');
}

function discountAmount_(disc, base) {
  if (!disc) return 0;
  return disc.type === 'PCT' ? Math.round(base * disc.value / 100) : disc.value;
}

function discountInfo_(disc) {
  if (!disc) return '';
  return disc.type === 'PCT' ? String(disc.value).replace('.', ',') + '%' : 'Rp ' + disc.value;
}

/** Rounds a cash total to the Cash_Rounding step. Returns the rounding amount (+ or -). */
function cashRounding_(amount, ch) {
  if (!ch.cashRounding) return 0;
  const step = ch.cashRounding;
  let r;
  if (ch.roundingMode === 'DOWN') r = Math.floor(amount / step) * step;
  else if (ch.roundingMode === 'UP') r = Math.ceil(amount / step) * step;
  else r = Math.round(amount / step) * step;
  return r - amount;
}

/** Splits an amount into parts (one per payment method). Cash parts are rounded one by one. */
function splitParts_(before, methods, ch) {
  const n = methods.length;
  const each = Math.floor(before / n);
  return methods.map(function (m, i) {
    const amount = i === n - 1 ? before - each * (n - 1) : each;
    const rounding = m === 'CASH' ? cashRounding_(amount, ch) : 0;
    return { method: m, amount: amount, rounding: rounding, due: amount + rounding };
  });
}

/**
 * Full calculation of an order. lines need .total (gross) and .disc.
 * opts: { billDisc, applyService, applyTax, methods: ['CASH', 'QRIS', ...] }  (old: cash: true/false)
 */
function calcTotals_(lines, opts, ch) {
  let subtotal = 0, itemDiscount = 0;
  lines.forEach(function (l) {
    l.discount = Math.min(l.total, discountAmount_(l.disc, l.total));
    l.netTotal = l.total - l.discount;
    subtotal += l.total;
    itemDiscount += l.discount;
  });
  const itemsNet = subtotal - itemDiscount;
  const billDiscount = Math.min(itemsNet, discountAmount_(opts.billDisc, itemsNet));
  const base = itemsNet - billDiscount;
  const service = opts.applyService && ch.servicePct > 0 ? Math.round(base * ch.servicePct / 100) : 0;
  const tax = opts.applyTax && ch.taxPct > 0 ? Math.round((base + service) * ch.taxPct / 100) : 0;
  const beforeRounding = base + service + tax;
  const methods = opts.methods && opts.methods.length ? opts.methods : [opts.cash ? 'CASH' : 'OTHER'];
  const parts = splitParts_(beforeRounding, methods, ch);
  const rounding = parts.reduce(function (s, p) { return s + p.rounding; }, 0);
  return {
    subtotal: subtotal, itemDiscount: itemDiscount, itemsNet: itemsNet, billDiscount: billDiscount,
    discount: itemDiscount + billDiscount, base: base, service: service, tax: tax,
    beforeRounding: beforeRounding, rounding: rounding, grand: beforeRounding + rounding, parts: parts
  };
}

function cleanNote_(v) { return cleanText_(v, 100); }
function cleanLid_(v) {
  const s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9_-]{2,24}$/.test(s) ? s : '';
}
function cleanGuest_(v) { return cleanText_(v, 40); }

/**
 * Validates order lines from the phone: [{ lid, productId, qty, disc, note }].
 * Lines are NOT merged: the same product may appear twice (e.g. one "pedas", one "tidak pedas").
 */
function parseLines_(items, allowEmpty) {
  if (!Array.isArray(items)) throw new Error('Data pesanan tidak lengkap.');
  if (!items.length && !allowEmpty) throw new Error('Keranjang masih kosong.');
  if (items.length > 150) throw new Error('Terlalu banyak baris dalam satu pesanan (maks. 150).');
  return items.map(function (it) {
    const id = String((it && it.productId) || '').trim();
    const q = Number(it && it.qty);
    if (!id) throw new Error('Ada item tanpa produk di keranjang.');
    if (!Number.isInteger(q) || q < 1 || q > 999) throw new Error('Jumlah item tidak valid (harus 1 sampai 999).');
    let mods = Array.isArray(it.mods) ? it.mods.map(function (m) { return String((m && m.id) || m || '').trim(); }).filter(String) : [];
    if (mods.length > 6) throw new Error('Terlalu banyak tambahan pada satu item (maks. 6).');
    mods = mods.filter(function (m, i) { return mods.indexOf(m) === i; });
    return { lid: cleanLid_(it.lid), productId: id, qty: q, disc: readDiscount_(it.disc, 'item'), note: cleanNote_(it.note), mods: mods };
  });
}

function modifierCategory_() { return String(getSettingsMap_().Modifier_Category || 'Add-ons').trim(); }
function lineUnit_(l) {
  return (Number(l.price) || 0) + (l.mods || []).reduce(function (s, m) { return s + (Number(m.price) || 0); }, 0);
}
function modsText_(mods) { return (mods || []).map(function (m) { return m.name; }).join(', '); }

/**
 * Add-ons (e.g. "Syrup Vanilla" +10.000) chosen on a line. They must be active products in the
 * Modifier_Category with the same recipe group as the item. oldMods = mods saved on a table line
 * (used when an add-on was switched off later).
 */
function priceMods_(ids, p, oldMods, products) {
  const cat = modifierCategory_().toLowerCase();
  const olds = {};
  (oldMods || []).forEach(function (m) { olds[m.id] = m; });
  return (ids || []).map(function (id) {
    const m = products[id];
    if (m) {
      if (String(m.category).toLowerCase() !== cat) throw new Error(m.name + ' bukan produk tambahan.');
      if (m.soldOut && !oldMods) throw jayaError_(m.name + ' sedang HABIS. Menu sudah dimuat ulang.', 'PRICE_CHANGED');
      if (p && m.recipeGroup !== p.recipeGroup) throw new Error(m.name + ' tidak bisa ditambahkan ke ' + p.name + '.');
      return { id: m.id, name: m.name, price: m.price, cost: m.cost, category: m.category, group: m.recipeGroup };
    }
    const o = olds[id];
    if (!o) throw jayaError_('Ada tambahan yang sudah tidak tersedia (' + id + '). Menu akan dimuat ulang.', 'PRICE_CHANGED');
    return { id: o.id, name: o.name, price: Number(o.price) || 0, cost: 0, category: modifierCategory_(), group: '' };
  });
}

/**
 * Prices each line with the CURRENT Products sheet price.
 * fallback (optional): { lid: storedLine } — lines already saved on a table keep their saved
 * name / price if the product was switched off later, so the bill can still be paid.
 */
function priceLines_(parsed, fallback, products) {
  products = products || productMap_();
  return parsed.map(function (l) {
    const p = products[l.productId];
    const old = fallback && l.lid ? fallback[l.lid] : null;
    if (!p && !old) throw jayaError_('Ada produk di keranjang yang sudah tidak tersedia (' + l.productId + '). Menu akan dimuat ulang.', 'PRICE_CHANGED');
    if (p && p.soldOut && !old) throw jayaError_(p.name + ' sedang HABIS. Hapus dari keranjang. Menu sudah dimuat ulang.', 'PRICE_CHANGED');
    const price = p ? p.price : Number(old.price) || 0;
    const mods = priceMods_(l.mods, p, old ? old.mods : null, products);
    const total = lineUnit_({ price: price, mods: mods }) * l.qty;
    const name = p ? p.name : old.name;
    if (l.disc && l.disc.type === 'AMT' && l.disc.value > total) throw new Error('Diskon untuk ' + name + ' lebih besar dari harganya.');
    return { lid: l.lid, productId: l.productId, name: name, category: p ? p.category : 'Other', qty: l.qty, price: price,
             cost: p ? p.cost : 0, total: total, disc: l.disc, note: l.note || '', group: p ? p.recipeGroup : (old.grp || 'NONE'),
             mods: mods };
  });
}

/** Cashiers may give at most Max_Discount_Percent of the order (admin: no limit). */
function checkDiscountAllowed_(user, tot, lines, billDisc) {
  const settings = getSettingsMap_();
  const isAdmin = hasPerm_(user, '*');
  const any = tot.discount > 0;
  if (any && !isAdmin && !isTrue_(settings.Allow_Discount)) throw new Error('Diskon dimatikan untuk kasir. Minta admin.');
  if (billDisc && billDisc.type === 'AMT' && billDisc.value > tot.itemsNet) throw new Error('Diskon bill lebih besar dari subtotal.');
  if (!any || isAdmin) return;
  const maxPct = Math.max(0, Math.min(100, numOr_(settings.Max_Discount_Percent, 100)));
  if (maxPct < 100 && tot.subtotal > 0 && tot.discount / tot.subtotal * 100 > maxPct + 1e-9) {
    throw new Error('Total diskon melebihi batas kasir (' + maxPct + '%). Minta admin.');
  }
}

function apiGetPosData(token) {
  return run_(function () {
    const user = requirePerm_(token, ['pos.sell', 'pos.order']);
    const s = getSettingsMap_();
    const isAdmin = hasPerm_(user, '*');
    const canPay = hasPerm_(user, 'pos.sell');
    let shiftOpen = false;
    try { shiftOpen = !!currentShift_(); } catch (e) { shiftOpen = false; }
    return {
      products: getActiveProducts_().map(function (p) {
        return { id: p.id, name: p.name, category: p.category, price: p.price, image: p.image, group: p.recipeGroup, soldOut: p.soldOut }; // cost is NOT sent
      }),
      categories: categoryOrder_(),
      allowDiscount: (isTrue_(s.Allow_Discount) || isAdmin) && canPay,
      maxDiscountPct: isAdmin ? 100 : Math.max(0, Math.min(100, numOr_(s.Max_Discount_Percent, 100))),
      showImages: isTrue_(s.Show_Product_Images),
      quickNotes: listSetting_('Quick_Notes').slice(0, 20),
      modifierCategory: modifierCategory_(),
      canPay: canPay,
      shift: { required: isTrue_(s.Require_Shift), open: shiftOpen, canManage: hasPerm_(user, 'shift.manage') },
      charges: chargeSettings_()
    };
  });
}

/** Payment parts from the phone: [{ method, amountPaid }]. Old phones send paymentMethod / amountPaid. */
function readPayments_(order) {
  let list = Array.isArray(order.payments) && order.payments.length ? order.payments
    : [{ method: order.paymentMethod, amountPaid: order.amountPaid }];
  if (list.length > 20) throw new Error('Bagi rata maksimal 20 bagian.');
  return list.map(function (p) {
    const m = String((p && p.method) || '');
    if (!PAYMENT_METHODS[m]) throw new Error('Pilih metode pembayaran' + (list.length > 1 ? ' untuk setiap bagian.' : '.'));
    return { method: m, amountPaid: p.amountPaid };
  });
}

/**
 * Lines of a table bill that are being paid now.
 * payLines: null = everything still on the bill, or [{ lid, qty }] for "split per item".
 * Returns { pay: [...], rest: [...] } — both in the stored line format.
 */
function pickPayLines_(stored, payLines) {
  if (!payLines) return { pay: stored.map(function (l) { return Object.assign({}, l); }), rest: [] };
  if (!Array.isArray(payLines) || !payLines.length) throw new Error('Pilih item yang mau dibayar.');
  const want = {};
  payLines.forEach(function (p) {
    const lid = cleanLid_(p && p.lid);
    const q = Number(p && p.qty);
    if (!lid || !Number.isInteger(q) || q < 0 || q > 999) throw new Error('Pilihan split bill tidak valid.');
    if (q > 0) want[lid] = (want[lid] || 0) + q;
  });
  const pay = [], rest = [];
  stored.forEach(function (l) {
    const q = want[l.lid] || 0;
    delete want[l.lid];
    if (q > l.qty) throw jayaError_('Jumlah ' + l.name + ' yang mau dibayar lebih banyak dari yang ada di bill. Bill sudah dimuat ulang.', 'STALE');
    if (!q) { rest.push(Object.assign({}, l)); return; }
    let payDisc = l.disc || null, restDisc = l.disc || null;
    if (l.disc && l.disc.type === 'AMT' && q < l.qty) {        // a Rupiah discount is shared by quantity
      const part = Math.round(l.disc.value * q / l.qty);
      payDisc = part > 0 ? { type: 'AMT', value: part } : null;
      restDisc = l.disc.value - part > 0 ? { type: 'AMT', value: l.disc.value - part } : null;
    }
    pay.push(Object.assign({}, l, { qty: q, disc: payDisc }));
    if (q < l.qty) rest.push(Object.assign({}, l, { qty: l.qty - q, disc: restDisc }));
  });
  if (Object.keys(want).length) throw jayaError_('Ada item yang sudah tidak ada di bill. Bill sudah dimuat ulang.', 'STALE');
  if (!pay.length) throw new Error('Pilih item yang mau dibayar.');
  return { pay: pay, rest: rest };
}

function apiCompleteOrder(token, order) {
  return run_(function () {
    const user = requirePerm_(token, 'pos.sell');
    const settings = getSettingsMap_();
    if (!order || typeof order !== 'object') throw new Error('Data pesanan tidak ada.');

    const clientRef = String(order.clientRef || '');
    if (!/^[A-Za-z0-9-]{10,64}$/.test(clientRef)) throw new Error('Referensi pesanan tidak valid. Muat ulang JayaPOS.');

    const payments = readPayments_(order);
    const methods = payments.map(function (p) { return p.method; });
    const openOrderId = String(order.openOrderId || '');
    const products = productMap_();
    const takeawayLines = openOrderId ? null : priceLines_(parseLines_(order.items, false), null, products);
    const ch = chargeSettings_();
    const billDisc = readDiscount_(order.billDiscount, 'bill');

    // COGS per serving from recipes (falls back to Products.Cost when a product has no recipe)
    let rdata = { recipes: {}, ingredients: {} };
    try { rdata = recipeDataCached_(); } catch (e) { console.error('recipe data: ' + e); }

    return withLock_(function () {
      const existingId = findTxIdByClientRef_(clientRef);
      if (existingId) {
        const r = buildReceipt_(existingId, settings);
        r.alreadySaved = true;
        return r;
      }

      const shift = shiftForPayment_(settings);

      let bill = null, lines, picked = null;
      if (openOrderId) {
        bill = getOpenOrder_(openOrderId);
        if (!bill) throw new Error('Bill meja ini tidak ditemukan. Kembali ke Meja dan buka lagi.');
        if (bill.status !== 'OPEN') throw jayaError_('Bill meja ini sudah ' + statusWord_(bill.status) + '.', 'STALE');
        if (bill.version !== Number(order.version)) {
          throw jayaError_('Bill ini baru diubah di HP lain (oleh ' + bill.updatedBy + '). Bill sudah dimuat ulang. Cek lagi lalu bayar.', 'STALE');
        }
        if (!bill.items.length) throw new Error('Bill ini masih kosong.');
        picked = pickPayLines_(bill.items, order.payLines || null);
        const fallback = {};
        bill.items.forEach(function (l) { fallback[l.lid] = l; });
        lines = priceLines_(picked.pay.map(function (l) {
          return { lid: l.lid, productId: l.id, qty: l.qty, disc: l.disc || null, note: l.note || '',
                   mods: (l.mods || []).map(function (m) { return m.id; }) };
        }), fallback, products);
      } else {
        lines = takeawayLines;
      }

      const tot = calcTotals_(lines, { billDisc: billDisc, applyService: order.applyService === true,
                                       applyTax: order.applyTax !== false, methods: methods }, ch);
      checkDiscountAllowed_(user, tot, lines, billDisc);

      if (order.expectedTotal !== undefined && Number(order.expectedTotal) !== tot.grand) {
        throw jayaError_('Harga atau pengaturan biaya berubah sejak menu dimuat. Menu sudah dimuat ulang. Cek totalnya lalu tekan tombol bayar lagi.', 'PRICE_CHANGED');
      }

      // money received, per part
      let paidTotal = 0, changeTotal = 0;
      tot.parts.forEach(function (part, i) {
        part.paid = part.due;
        part.change = 0;
        if (part.method === 'CASH') {
          const paid = Number(payments[i].amountPaid);
          const who = tot.parts.length > 1 ? ' (bagian ' + (i + 1) + ')' : '';
          if (!Number.isInteger(paid) || paid < 0) throw new Error('Isi jumlah uang tunai yang diterima' + who + '.');
          if (paid < part.due) throw new Error('Uang tunai kurang dari total' + who + '.');
          if (paid > part.due + 10000000) throw new Error('Jumlah uang tunai sepertinya salah' + who + '. Cek lagi.');
          part.paid = paid;
          part.change = paid - part.due;
        }
        paidTotal += part.paid;
        changeTotal += part.change;
      });
      const sameMethod = methods.every(function (m) { return m === methods[0]; });
      const method = sameMethod ? methods[0] : 'MIXED';

      lines.forEach(function (l) {
        if (rdata.recipes[l.productId]) l.cost = rdata.recipes[l.productId].perServing;
        l.mods.forEach(function (m) { if (rdata.recipes[m.id]) m.cost = rdata.recipes[m.id].perServing; });
      });

      const now = new Date();
      const dateKey = fmt_(now, 'yyyyMMdd');
      const prefix = (String(settings.Tx_Prefix || 'JY').toUpperCase().replace(/[^A-Z]/g, '') || 'JY').slice(0, 5);
      const props = PropertiesService.getScriptProperties();
      const seqKey = 'TXSEQ_' + prefix + '_' + dateKey;
      let seq = Number(props.getProperty(seqKey) || 0);
      let txId;
      do {
        seq++;
        txId = prefix + '-' + dateKey + '-' + String(seq).padStart(4, '0');
      } while (getTransactionById_(txId)); // extra guard if the counter was ever reset
      props.setProperty(seqKey, String(seq));

      const priorPaid = bill ? bill.paidTx.length : 0;
      const partial = !!(picked && picked.rest.length);
      const split = [];
      if (bill && (partial || priorPaid)) split.push('Split bill ke-' + (priorPaid + 1));
      if (tot.parts.length > 1) split.push('Bagi rata ' + tot.parts.length);
      const guest = bill ? bill.guestName : cleanGuest_(order.guestName);

      const dateStr = fmt_(now, 'yyyy-MM-dd');
      const stamp = fmt_(now, 'yyyy-MM-dd HH:mm:ss');
      appendObjects_('Transaction_Details', detailRows_(txId, dateStr, lines));
      appendObjects_('Transactions', [{
        Transaction_ID: txId, Date: dateStr, Time: fmt_(now, 'HH:mm'), Cashier: user.name,
        Subtotal: tot.subtotal, Discount: tot.discount, Grand_Total: tot.grand, Payment_Method: method,
        Amount_Paid: paidTotal, Change: changeTotal, Status: 'COMPLETED', Cashier_ID: user.id,
        Timestamp: stamp, Client_Ref: clientRef, Outlet_ID: settings.Outlet_ID || '', Notes: '',
        Order_Type: bill ? 'DINE_IN' : 'TAKEAWAY', Table_Name: bill ? bill.tableName : '',
        Pax: bill ? (priorPaid ? 0 : bill.pax) : '',
        Service_Charge: tot.service, Tax: tot.tax, Order_ID: bill ? bill.id : '',
        Item_Discount: tot.itemDiscount, Bill_Discount: tot.billDiscount, Bill_Discount_Info: discountInfo_(billDisc),
        Rounding: tot.rounding, Void_Reason: '', Void_By: '', Void_At: '',
        Guest_Name: guest, Shift_ID: shift ? shift.id : '', Split_Info: split.join(' · '),
        Duration_Min: bill && bill.openedMs ? Math.max(0, Math.round((now.getTime() - bill.openedMs) / 60000)) : ''
      }]);
      appendObjects_('Payments', tot.parts.map(function (p, i) {
        return { Payment_ID: txId + '-' + (i + 1), Transaction_ID: txId, Seq: i + 1, Date: dateStr, Method: p.method,
                 Amount: p.due, Rounding: p.rounding, Paid: p.paid, Change: p.change, Shift_ID: shift ? shift.id : '',
                 Status: 'COMPLETED', Timestamp: stamp };
      }));

      let remaining = null;
      if (bill) {
        const paidTx = bill.paidTx.concat([txId]);
        if (picked.rest.length) {
          const restTotals = calcTotals_(picked.rest.map(function (l) { return { total: lineUnit_(l) * l.qty, disc: l.disc }; }), {}, ch);
          updateRow_('Open_Orders', bill.row, {
            Items_JSON: JSON.stringify(picked.rest), Subtotal: restTotals.itemsNet, Paid_Transactions: paidTx.join(','),
            Updated_At: stamp, Updated_By: user.name, Version: bill.version + 1
          });
          remaining = publicOrder_(getOpenOrder_(bill.id));
        } else {
          updateRow_('Open_Orders', bill.row, {
            Status: 'PAID', Subtotal: 0, Transaction_ID: txId, Closed_At: stamp, Paid_Transactions: paidTx.join(','),
            Updated_At: stamp, Updated_By: user.name, Version: bill.version + 1
          });
        }
      }
      SpreadsheetApp.flush();
      CacheService.getScriptCache().put('ref_' + clientRef, txId, 21600);
      if (!bill) {
        createTicket_({ orderId: txId, tableName: 'Takeaway', guest: guest, round: 1, kind: 'ORDER', user: user },
                      lines.map(function (l) { return { id: l.productId, name: l.name, qty: l.qty, note: l.note, grp: l.group, mods: l.mods }; }), products);
      }
      try { inventoryOnSale_(txId, stockLines_(lines), user, rdata); }
      catch (e) { audit_(user, 'INVENTORY_ERROR', 'Transaction', txId, String(e && e.message || e)); }
      if (order.applyTax === false && ch.taxPct > 0) {
        audit_(user, 'TAX_REMOVED', 'Transaction', txId, { total: tot.grand });
      }
      if (split.length) audit_(user, 'SPLIT_BILL', 'Transaction', txId, { order: bill ? bill.id : '', info: split.join(' · '), total: tot.grand });

      const receipt = buildReceipt_(txId, settings);
      if (remaining) receipt.openOrder = remaining;
      if (shift && methods.indexOf('CASH') >= 0) {
        try { receipt.drawerFull = drawerFull_(shift, settings); } catch (e) { receipt.drawerFull = false; }
      }
      return receipt;
    });
  });
}

/** One row per item, plus one row per add-on (Modifier_Of = the item's Line_No). The line discount is shared by value. */
function detailRows_(txId, dateStr, lines) {
  const rows = [];
  let n = 0;
  lines.forEach(function (l) {
    const no = ++n;
    const baseGross = l.price * l.qty;
    let left = l.discount;
    const modRows = l.mods.map(function (m) {
      const gross = m.price * l.qty;
      const d = l.total ? Math.round(l.discount * gross / l.total) : 0;
      left -= d;
      return { Transaction_ID: txId, Line_No: ++n, Product_ID: m.id, Product_Name: m.name, Category: m.category, Quantity: l.qty,
               Unit_Price: m.price, Total: gross, Unit_Cost: m.cost || 0, Date: dateStr, Discount: d, Discount_Info: discountInfo_(l.disc),
               Net_Total: gross - d, Note: '', Modifier_Of: no };
    });
    rows.push({ Transaction_ID: txId, Line_No: no, Product_ID: l.productId, Product_Name: l.name, Category: l.category, Quantity: l.qty,
                Unit_Price: l.price, Total: baseGross, Unit_Cost: l.cost, Date: dateStr, Discount: left, Discount_Info: discountInfo_(l.disc),
                Net_Total: baseGross - left, Note: l.note || '', Modifier_Of: '' });
    modRows.forEach(function (r) { rows.push(r); });
  });
  return rows;
}

/** Items + add-ons as separate lines, for recipe stock deduction. */
function stockLines_(lines) {
  const out = [];
  lines.forEach(function (l) {
    out.push(l);
    l.mods.forEach(function (m) { out.push({ productId: m.id, qty: l.qty }); });
  });
  return out;
}

function statusWord_(s) {
  return { PAID: 'dibayar', CANCELLED: 'dibatalkan', VOID: 'di-void', OPEN: 'terbuka', COMPLETED: 'selesai',
           MERGED: 'digabung ke meja lain' }[s] || String(s).toLowerCase();
}

function methodLabel_(m) { return m === 'MIXED' ? MIXED_LABEL : (PAYMENT_METHODS[m] || m); }

function findTxIdByClientRef_(clientRef) {
  const cached = CacheService.getScriptCache().get('ref_' + clientRef);
  if (cached) return cached;
  const sh = getSheet_('Transactions');
  const headers = getHeaders_(sh);
  const rows = findRowNumbers_(sh, headers, 'Client_Ref', clientRef);
  if (!rows.length) return null;
  return String(rowObject_(sh, headers, rows[0]).Transaction_ID);
}

function getTransactionById_(txId) {
  const sh = getSheet_('Transactions');
  const headers = getHeaders_(sh);
  const rows = findRowNumbers_(sh, headers, 'Transaction_ID', txId);
  if (!rows.length) return null;
  const t = txFromRow_(rowObject_(sh, headers, rows[0]));
  t.row = rows[0];
  return t;
}

/** Rows of a sheet whose `header` equals value, read in one block. */
function rowsWhere_(name, header, value) {
  const sh = getSheet_(name);
  const headers = getHeaders_(sh);
  const rowNums = findRowNumbers_(sh, headers, header, value);
  if (!rowNums.length) return [];
  const min = Math.min.apply(null, rowNums);
  const max = Math.max.apply(null, rowNums);
  const values = sh.getRange(min, 1, max - min + 1, headers.length).getValues();
  return values.map(function (r, i) {
    const o = { _row: min + i };
    headers.forEach(function (h, j) { if (h) o[h] = r[j]; });
    return o;
  }).filter(function (o) { return String(o[header]) === String(value); });
}

function getTransactionDetails_(txId) {
  return rowsWhere_('Transaction_Details', 'Transaction_ID', txId)
    .sort(function (a, b) { return Number(a.Line_No) - Number(b.Line_No); })
    .map(function (o) {
      const total = moneyNum_(o.Total) || 0;
      const disc = moneyNum_(o.Discount) || 0;
      return { productId: String(o.Product_ID), name: String(o.Product_Name), category: String(o.Category),
               qty: Number(o.Quantity) || 0, price: moneyNum_(o.Unit_Price) || 0, total: total,
               discount: disc, discountInfo: String(o.Discount_Info || ''), netTotal: total - disc, note: String(o.Note || ''),
               lineNo: Number(o.Line_No) || 0, modifierOf: Number(o.Modifier_Of) || 0 };
    });
}

function getPayments_(txId) {
  return rowsWhere_('Payments', 'Transaction_ID', txId)
    .sort(function (a, b) { return Number(a.Seq) - Number(b.Seq); })
    .map(function (o) {
      const m = String(o.Method || '');
      return { row: o._row, seq: Number(o.Seq) || 1, method: m, label: methodLabel_(m), amount: moneyNum_(o.Amount) || 0,
               rounding: moneyNum_(o.Rounding) || 0, paid: moneyNum_(o.Paid) || 0, change: moneyNum_(o.Change) || 0,
               status: String(o.Status || 'COMPLETED') };
    });
}

function txFromRow_(r) {
  const date = dateText_(r.Date);
  const method = String(r.Payment_Method || '').trim();
  return {
    id: String(r.Transaction_ID).trim(),
    date: date,
    dateLabel: dateLabel_(date),
    time: timeText_(r.Time),
    cashier: String(r.Cashier || ''),
    cashierId: String(r.Cashier_ID || ''),
    subtotal: moneyNum_(r.Subtotal) || 0,
    discount: moneyNum_(r.Discount) || 0,
    itemDiscount: moneyNum_(r.Item_Discount) || 0,
    billDiscount: isFinite(moneyNum_(r.Bill_Discount)) ? moneyNum_(r.Bill_Discount) : (moneyNum_(r.Discount) || 0),
    billDiscountInfo: String(r.Bill_Discount_Info || ''),
    service: moneyNum_(r.Service_Charge) || 0,
    tax: moneyNum_(r.Tax) || 0,
    rounding: moneyNum_(r.Rounding) || 0,
    total: moneyNum_(r.Grand_Total) || 0,
    method: method,
    methodLabel: methodLabel_(method),
    amountPaid: moneyNum_(r.Amount_Paid) || 0,
    change: moneyNum_(r.Change) || 0,
    status: String(r.Status || '').trim().toUpperCase() || 'COMPLETED',
    orderType: String(r.Order_Type || '').trim().toUpperCase() || 'TAKEAWAY',
    tableName: String(r.Table_Name || '').trim(),
    pax: Number(r.Pax) || 0,
    orderId: String(r.Order_ID || '').trim(),
    guestName: String(r.Guest_Name || '').trim(),
    shiftId: String(r.Shift_ID || '').trim(),
    splitInfo: String(r.Split_Info || '').trim(),
    durationMin: r.Duration_Min === '' || r.Duration_Min == null || !isFinite(Number(r.Duration_Min)) ? null : Number(r.Duration_Min),
    voidReason: String(r.Void_Reason || ''),
    voidBy: String(r.Void_By || ''),
    voidAt: cellText_(r.Void_At),
    stamp: cellText_(r.Timestamp) || (date + ' ' + timeText_(r.Time))
  };
}

function buildReceipt_(txId, settings) {
  settings = settings || getSettingsMap_();
  const t = getTransactionById_(txId);
  if (!t) throw new Error('Transaksi ' + txId + ' tidak ditemukan.');
  delete t.row;
  t.items = getTransactionDetails_(txId);
  let pays = [];
  try { pays = getPayments_(txId); } catch (e) { pays = []; }
  t.payments = pays.length ? pays.map(function (p) { delete p.row; return p; })
    : [{ seq: 1, method: t.method, label: t.methodLabel, amount: t.total, rounding: t.rounding, paid: t.amountPaid, change: t.change }];
  t.header = {
    business: settings.Business_Name || '',
    app: settings.App_Name || 'JayaPOS',
    address: settings.Receipt_Address || '',
    phone: settings.Receipt_Phone || '',
    footer: settings.Receipt_Footer || 'Terima Kasih',
    widthMm: String(settings.Receipt_Width_mm) === '80' ? 80 : 58,
    serviceLabel: settings.Service_Label || 'Service',
    taxLabel: settings.Tax_Label || 'PB1'
  };
  return t;
}

// ---------------- Menu habis (sold out) ----------------

/** Every active product (menu + add-ons) with its sold-out state. */
function apiGetSoldOut(token) {
  return run_(function () {
    requirePerm_(token, 'menu.soldout');
    const order = categoryOrder_();
    const list = getActiveProducts_().map(function (p) {
      return { id: p.id, name: p.name, category: p.category, soldOut: p.soldOut, by: p.soldOutBy, at: p.soldOutAt.slice(0, 16) };
    });
    const cats = [];
    list.forEach(function (p) { if (cats.indexOf(p.category) < 0) cats.push(p.category); });
    cats.sort(function (a, b) {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return { categories: cats, products: list, count: list.filter(function (p) { return p.soldOut; }).length };
  });
}

/** Marks a product sold out (soldOut = true) or available again. It stays sold out until someone switches it back. */
function apiSetSoldOut(token, productId, soldOut) {
  return run_(function () {
    const user = requirePerm_(token, 'menu.soldout');
    return withLock_(function () {
      const p = getActiveProducts_().filter(function (x) { return x.id === String(productId || ''); })[0];
      if (!p) throw new Error('Produk tidak ditemukan. Muat ulang.');
      const on = soldOut === true;
      if (p.soldOut !== on) {
        updateRow_('Products', p.row, { Sold_Out: on, Sold_Out_By: on ? user.name : '', Sold_Out_At: on ? nowStamp_() : '' });
        audit_(user, on ? 'SOLD_OUT' : 'SOLD_OUT_CLEAR', 'Product', p.id, { name: p.name });
      }
      return { id: p.id, soldOut: on, by: on ? user.name : '', at: on ? nowStamp_().slice(0, 16) : '' };
    });
  });
}

/** Numbers for the cashier home screen. */
function apiGetHome(token) {
  return run_(function () {
    const user = requirePerm_(token, ['pos.sell', 'pos.order']);
    const s = getSettingsMap_();
    let shift = null;
    try { const c = currentShift_(); if (c) shift = { id: c.id, openedAt: c.openedAt.slice(11, 16), openedBy: c.openedBy }; } catch (e) { shift = null; }
    let tables = 0, busy = 0, openAmount = 0;
    try {
      const f = floorData_(user);
      tables = f.tables.length;
      Object.keys(f.open).forEach(function (k) { busy++; openAmount += f.open[k].subtotal; });
    } catch (e) { /* no tables */ }
    let soldOut = 0;
    try { soldOut = getActiveProducts_().filter(function (p) { return p.soldOut; }).length; } catch (e) { soldOut = 0; }
    let kitchen = 0;
    try {
      const today = todayStr_();
      readRecentRows_('Kitchen_Tickets', 300).forEach(function (r) {
        if (dateText_(r.Date) === today && (String(r.Food_Status) === 'NEW' || String(r.Bar_Status) === 'NEW')) kitchen++;
      });
    } catch (e) { kitchen = 0; }
    return {
      business: s.Business_Name || '', user: user.name, shiftRequired: isTrue_(s.Require_Shift), shift: shift,
      canManageShift: hasPerm_(user, 'shift.manage'), tables: tables, busy: busy, openAmount: openAmount,
      soldOut: soldOut, kitchen: kitchen
    };
  });
}
