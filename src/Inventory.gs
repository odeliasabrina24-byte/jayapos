/**
 * Inventory.gs  (Phase 2 + stock part of Phase 3)
 * Ingredients, recipes, COGS per serving, stock levels, waste and stock counts.
 *
 * How costing works:
 *  - Every ingredient has ONE base unit: g, ml, pcs or portion.
 *  - It is bought in a Purchase_Unit (e.g. "kg", "bottle 1L", "box 24") with Purchase_To_Base
 *    = how many base units are in one purchase unit (kg = 1000 g, box = 24 pcs).
 *  - Goods receiving (Purchasing.gs) sets Cost_Per_Base_Unit from the REAL price paid
 *    (weighted average or last price, see Settings > Costing_Method).
 *  - A recipe line says e.g. "250 g pork belly". Its cost = 250 x cost per g.
 *    Recipe cost / Yield_Quantity (servings) = COGS per serving.
 *  - Units only convert inside the same base: kg<->g, l<->ml. g->ml is refused.
 *  - Each sale saves the COGS per serving at that moment (Transaction_Details.Unit_Cost)
 *    and, if Deduct_Stock_On_Sale is TRUE, takes the ingredients out of stock.
 */

// ---------------- Lists & access ----------------

function ingredientsList_() {
  return readTable_('Ingredients').rows.map(function (r) {
    const group = String(r.Ingredient_Group || '').trim().toUpperCase();
    const base = String(r.Base_Unit || '').trim().toLowerCase();
    const ptb = numOr_(r.Purchase_To_Base, 1);
    return {
      row: r._row,
      id: String(r.Ingredient_ID).trim(),
      name: String(r.Ingredient_Name).trim(),
      group: INGREDIENT_GROUPS.indexOf(group) >= 0 ? group : 'FOOD',
      baseUnit: BASE_UNITS.indexOf(base) >= 0 ? base : 'pcs',
      purchaseUnit: String(r.Purchase_Unit || '').trim() || base || 'pcs',
      purchaseToBase: ptb > 0 ? ptb : 1,
      cost: Math.max(0, numOr_(r.Cost_Per_Base_Unit, 0)),
      lastPrice: moneyNum_(r.Last_Purchase_Price) || 0,
      stock: numOr_(r.Stock_Qty_Base, 0),
      minStock: Math.max(0, numOr_(r.Min_Stock_Base, 0)),
      supplierId: String(r.Default_Supplier_ID || '').trim(),
      active: String(r.Active_Status == null ? '' : r.Active_Status).trim() === '' ? true : isTrue_(r.Active_Status)
    };
  }).filter(function (i) { return i.id && i.name; });
}

function groupWord_(g) { return { FOOD: 'makanan', BEVERAGE: 'minuman', SHARED: 'bersama' }[g] || String(g || '').toLowerCase(); }

function uniq_(arr) { return arr.filter(function (v, i) { return arr.indexOf(v) === i; }); }

/** Which ingredient groups a user may see / change. */
function ingredientAccess_(user) {
  const r = user;
  if (hasPerm_(r, '*') || hasPerm_(r, 'ingredients.purchasing')) return { view: INGREDIENT_GROUPS.slice(), edit: INGREDIENT_GROUPS.slice() };
  let view = [], edit = [];
  ['food', 'beverage'].forEach(function (g) {
    const G = g.toUpperCase();
    if (['ingredients.', 'recipes.', 'cogs.', 'stock.'].some(function (p) { return hasPerm_(r, p + g); })) view.push(G, 'SHARED');
    if (hasPerm_(r, 'ingredients.' + g)) edit.push(G, 'SHARED');
  });
  if (hasPerm_(r, 'inventory.view') || hasPerm_(r, 'purchasing.view')) view = INGREDIENT_GROUPS.slice();
  return { view: uniq_(view), edit: uniq_(edit) };
}

function canRecipe_(user, group, kind) {   // kind: 'edit' | 'view'
  const r = user;
  if (hasPerm_(r, '*')) return true;
  const g = group === 'BEVERAGE' ? 'beverage' : (group === 'FOOD' ? 'food' : '');
  if (!g) return false;
  if (kind === 'edit') return hasPerm_(r, 'recipes.' + g);
  return hasPerm_(r, 'recipes.' + g) || hasPerm_(r, 'cogs.' + g) || hasPerm_(r, 'reports.view');
}

function canStock_(user, group, kind) {    // kind: 'view' | 'waste'
  const r = user;
  if (hasPerm_(r, '*')) return true;
  if (kind === 'view' && hasPerm_(r, 'inventory.view')) return true;
  if (group === 'SHARED') return hasPerm_(r, 'stock.food') || hasPerm_(r, 'stock.beverage');
  return hasPerm_(r, 'stock.' + (group === 'BEVERAGE' ? 'beverage' : 'food'));
}

function unitsForBase_(base) {
  return Object.keys(UNITS).filter(function (u) { return UNITS[u].base === base; });
}

function publicUnits_() {
  const out = {};
  BASE_UNITS.forEach(function (b) { out[b] = unitsForBase_(b); });
  return out;
}

// ---------------- Recipe maths ----------------

/** All active recipes with live costs. productId -> recipe. */
function recipeData_() {
  const ings = {};
  ingredientsList_().forEach(function (i) { ings[i.id] = i; });
  const details = {};
  readTable_('Recipe_Details').rows.forEach(function (d) {
    const id = String(d.Recipe_ID).trim();
    (details[id] = details[id] || []).push(d);
  });
  const recipes = {};
  readTable_('Recipes').rows.forEach(function (r) {
    if (!isTrue_(r.Active_Status)) return;
    const recipeId = String(r.Recipe_ID).trim();
    const productId = String(r.Product_ID).trim();
    if (!recipeId || !productId) return;
    const yieldQty = numOr_(r.Yield_Quantity, 1) > 0 ? numOr_(r.Yield_Quantity, 1) : 1;
    const problems = [];
    const lines = (details[recipeId] || [])
      .sort(function (a, b) { return Number(a.Line_No) - Number(b.Line_No); })
      .map(function (d) {
        const ing = ings[String(d.Ingredient_ID).trim()];
        const qty = numOr_(d.Quantity_Required, 0);
        const unit = String(d.Unit || '').trim().toLowerCase();
        let baseQty = 0, unitCost = 0, problem = '';
        if (!ing) problem = 'Bahan ' + d.Ingredient_ID + ' tidak ditemukan';
        else {
          try { baseQty = convertQty_(qty, unit, ing.baseUnit); } catch (e) { problem = ing.name + ': ' + e.message; }
          unitCost = UNITS[unit] ? ing.cost * UNITS[unit].factor : 0;
          if (!problem && ing.cost === 0) problem = ing.name + ' belum punya harga pokok (belum ada pembelian)';
        }
        if (problem) problems.push(problem);
        return {
          ingredientId: String(d.Ingredient_ID).trim(), name: ing ? ing.name : '(missing)', qty: qty, unit: unit,
          baseQty: baseQty, baseUnit: ing ? ing.baseUnit : '', unitCost: round4_(unitCost), cost: baseQty * (ing ? ing.cost : 0)
        };
      });
    const total = lines.reduce(function (s, l) { return s + l.cost; }, 0);
    const consumption = {};
    lines.forEach(function (l) {
      if (l.baseQty > 0 && ings[l.ingredientId]) consumption[l.ingredientId] = (consumption[l.ingredientId] || 0) + l.baseQty / yieldQty;
    });
    recipes[productId] = {
      recipeId: recipeId, productId: productId, yieldQty: yieldQty, notes: String(r.Notes || ''),
      updatedAt: cellText_(r.Updated_At), updatedBy: String(r.Updated_By || ''), row: r._row,
      lines: lines, totalCost: Math.round(total), perServing: Math.round(total / yieldQty),
      consumption: consumption, problems: problems
    };
  });
  return { recipes: recipes, ingredients: ings };
}

/** Same data, cached for 5 minutes for the POS (faster sales). Cleared whenever costs or recipes change. */
function recipeDataCached_() {
  const cache = CacheService.getScriptCache();
  const raw = cache.get('recipeData');
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  const d = recipeData_();
  try { cache.put('recipeData', JSON.stringify(d), 300); } catch (e) { /* too big for cache: fine */ }
  return d;
}
function clearRecipeCache_() { CacheService.getScriptCache().remove('recipeData'); }

/** Updates one column for some rows in a single read + write. updates = { sheetRow: value } */
function setColumnValues_(name, header, updates) {
  const rows = Object.keys(updates);
  if (!rows.length) return;
  const sh = getSheet_(name);
  const c = getHeaders_(sh).indexOf(header);
  if (c < 0) throw new Error('Kolom "' + header + '" tidak ada di sheet ' + name + '. Jalankan JayaPOS > 1. Setup / perbaiki database.');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const range = sh.getRange(2, c + 1, lastRow - 1, 1);
  const vals = range.getValues();
  rows.forEach(function (r) { const i = Number(r) - 2; if (i >= 0 && i < vals.length) vals[i][0] = updates[r]; });
  range.setValues(vals);
}

/** Keeps Products.Cost equal to the recipe COGS per serving (for products that have a recipe). */
function refreshProductCosts_(data) {
  data = data || recipeData_();
  const updates = {};
  readTable_('Products').rows.forEach(function (r) {
    const rc = data.recipes[String(r.Product_ID).trim()];
    if (rc && moneyNum_(r.Cost) !== rc.perServing) updates[r._row] = rc.perServing;
  });
  setColumnValues_('Products', 'Cost', updates);
  clearRecipeCache_();
}

// ---------------- Stock movements ----------------

function nextSeq_(key, count) {
  const props = PropertiesService.getScriptProperties();
  const start = Number(props.getProperty(key) || 0);
  props.setProperty(key, String(start + count));
  return start;
}

/**
 * Writes movements and updates stock (and costs) in a few sheet calls.
 * moves: [{ ing, type, qty, unit, baseQty (signed), unitCost (per base), ref, notes, supplierId }]
 * costUpdates: { ingredientId: { cost: perBase, lastPrice: perPurchaseUnit } }
 * Call inside withLock_.
 */
function applyMovements_(moves, user, costUpdates) {
  costUpdates = costUpdates || {};
  if (!moves.length && !Object.keys(costUpdates).length) return;
  const now = new Date();
  const dateKey = fmt_(now, 'yyyyMMdd');
  const stamp = fmt_(now, 'yyyy-MM-dd HH:mm:ss');
  const date = fmt_(now, 'yyyy-MM-dd');
  if (moves.length) {
    const start = nextSeq_('MVSEQ_' + dateKey, moves.length);
    appendObjects_('Inventory_Movements', moves.map(function (m, i) {
      return {
        Movement_ID: 'MV-' + dateKey + '-' + String(start + i + 1).padStart(4, '0'), Timestamp: stamp, Date: date,
        Ingredient_ID: m.ing.id, Ingredient_Name: m.ing.name, Movement_Type: m.type, Quantity: round4_(m.qty), Unit: m.unit,
        Quantity_Base: round4_(m.baseQty), Unit_Cost_Base: round4_(m.unitCost), Total_Cost: Math.round(m.baseQty * m.unitCost),
        Reference_ID: m.ref || '', User_ID: user ? user.id : 'SYSTEM', Notes: m.notes || '', Supplier_ID: m.supplierId || ''
      };
    }));
  }
  const current = {};
  ingredientsList_().forEach(function (i) { current[i.id] = i; });
  const stockUpd = {}, costUpd = {}, lastUpd = {}, stampUpd = {};
  moves.forEach(function (m) {
    const ing = current[m.ing.id];
    if (!ing) return;
    ing.stock = round4_(ing.stock + m.baseQty);
    stockUpd[ing.row] = ing.stock;
  });
  Object.keys(costUpdates).forEach(function (id) {
    const ing = current[id];
    if (!ing) return;
    const u = costUpdates[id];
    if (u.cost !== undefined) costUpd[ing.row] = round4_(u.cost);
    if (u.lastPrice !== undefined) lastUpd[ing.row] = u.lastPrice;
    stampUpd[ing.row] = stamp;
  });
  setColumnValues_('Ingredients', 'Stock_Qty_Base', stockUpd);
  setColumnValues_('Ingredients', 'Cost_Per_Base_Unit', costUpd);
  setColumnValues_('Ingredients', 'Last_Purchase_Price', lastUpd);
  setColumnValues_('Ingredients', 'Updated_At', stampUpd);
  if (Object.keys(costUpd).length) clearRecipeCache_();
}

/** Called after a sale is saved: takes recipe ingredients out of stock. Never blocks the sale. */
function inventoryOnSale_(txId, lines, user, rdata) {
  if (!isTrue_(getSettingsMap_().Deduct_Stock_On_Sale)) return;
  const totals = {};
  lines.forEach(function (l) {
    const rc = rdata.recipes[l.productId];
    if (!rc) return;
    Object.keys(rc.consumption).forEach(function (ingId) {
      totals[ingId] = (totals[ingId] || 0) + rc.consumption[ingId] * l.qty;
    });
  });
  const moves = Object.keys(totals).map(function (ingId) {
    const ing = rdata.ingredients[ingId];
    return { ing: ing, type: 'SALE', qty: -totals[ingId], unit: ing.baseUnit, baseQty: -totals[ingId], unitCost: ing.cost, ref: txId };
  }).filter(function (m) { return m.ing; });
  applyMovements_(moves, user, {});
}

// ---------------- Ingredients API ----------------

function apiGetIngredients(token) {
  return run_(function () {
    const user = requirePerm_(token, ['ingredients.food', 'ingredients.beverage', 'ingredients.purchasing', 'inventory.view',
      'recipes.food', 'recipes.beverage', 'stock.food', 'stock.beverage', 'cogs.food', 'cogs.beverage', 'purchasing.manage', 'purchasing.view']);
    const acc = ingredientAccess_(user);
    const sup = {};
    suppliersList_().forEach(function (s) { sup[s.id] = s; });
    return {
      ingredients: ingredientsList_().filter(function (i) { return acc.view.indexOf(i.group) >= 0; }).map(function (i) {
        return { id: i.id, name: i.name, group: i.group, baseUnit: i.baseUnit, purchaseUnit: i.purchaseUnit,
                 purchaseToBase: i.purchaseToBase, cost: round4_(i.cost), costPerPurchaseUnit: Math.round(i.cost * i.purchaseToBase),
                 lastPrice: i.lastPrice, stock: i.stock, minStock: i.minStock, supplierId: i.supplierId,
                 supplierName: sup[i.supplierId] ? sup[i.supplierId].name : '', active: i.active,
                 value: Math.round(Math.max(0, i.stock) * i.cost), low: i.active && i.minStock > 0 && i.stock < i.minStock };
      }),
      editGroups: acc.edit,
      canAdjust: hasPerm_(user, '*'),
      units: publicUnits_(),
      suppliers: suppliersList_().filter(function (s) { return s.active; }).map(function (s) { return { id: s.id, name: s.name }; })
    };
  });
}

function apiSaveIngredient(token, d) {
  return run_(function () {
    const user = requirePerm_(token, ['ingredients.food', 'ingredients.beverage', 'ingredients.purchasing']);
    const acc = ingredientAccess_(user);
    d = d || {};
    const name = cleanText_(d.name, 60);
    const group = String(d.group || '').toUpperCase();
    const base = String(d.baseUnit || '').toLowerCase();
    const pUnit = cleanText_(d.purchaseUnit, 20) || base;
    const ptb = Number(d.purchaseToBase);
    const minStock = Number(d.minStock || 0);
    const supplierId = String(d.supplierId || '').trim();
    if (!name) throw new Error('Nama bahan wajib diisi.');
    if (INGREDIENT_GROUPS.indexOf(group) < 0) throw new Error('Pilih grup: Makanan, Minuman atau Bersama.');
    if (acc.edit.indexOf(group) < 0) throw jayaError_('Akses ditolak. Role Anda tidak boleh mengelola bahan ' + groupWord_(group) + '.', 'DENIED');
    if (BASE_UNITS.indexOf(base) < 0) throw new Error('Satuan dasar harus g, ml, pcs atau portion.');
    if (!isFinite(ptb) || ptb <= 0 || ptb > 1000000) throw new Error('"Isi per satuan beli" harus angka di atas 0 (contoh 1000 untuk kg → g).');
    if (!isFinite(minStock) || minStock < 0) throw new Error('Stok minimum harus 0 atau lebih.');
    if (supplierId && !suppliersList_().some(function (s) { return s.id === supplierId; })) throw new Error('Supplier tidak ditemukan.');

    return withLock_(function () {
      const list = ingredientsList_();
      if (list.some(function (i) { return i.name.toLowerCase() === name.toLowerCase() && i.id !== String(d.id || ''); })) {
        throw new Error('Bahan bernama "' + name + '" sudah ada.');
      }
      const fields = { Ingredient_Name: name, Ingredient_Group: group, Base_Unit: base, Purchase_Unit: pUnit, Purchase_To_Base: ptb,
                       Min_Stock_Base: minStock, Default_Supplier_ID: supplierId, Active_Status: d.active !== false, Updated_At: nowStamp_() };
      let id = String(d.id || '');
      if (id) {
        const old = list.filter(function (i) { return i.id === id; })[0];
        if (!old) throw new Error('Bahan tidak ditemukan.');
        if (acc.edit.indexOf(old.group) < 0) throw jayaError_('Akses ditolak. Role Anda tidak boleh mengubah bahan ' + groupWord_(old.group) + '.', 'DENIED');
        if (old.baseUnit !== base) {
          const used = readTable_('Recipe_Details').rows.some(function (r) { return String(r.Ingredient_ID).trim() === id; });
          if (used || old.stock !== 0) throw new Error('Satuan dasar tidak bisa diubah selama bahan masih punya stok atau dipakai di resep.');
        }
        updateRow_('Ingredients', old.row, fields);
        audit_(user, 'INGREDIENT_UPDATE', 'Ingredient', id, { before: { name: old.name, group: old.group, base: old.baseUnit, purchaseUnit: old.purchaseUnit, purchaseToBase: old.purchaseToBase }, after: { name: name, group: group, base: base, purchaseUnit: pUnit, purchaseToBase: ptb } });
      } else {
        id = nextId_(list.map(function (i) { return i.id; }), 'I', 3);
        fields.Ingredient_ID = id;
        fields.Cost_Per_Base_Unit = 0;
        fields.Last_Purchase_Price = 0;
        fields.Stock_Qty_Base = 0;
        appendObjects_('Ingredients', [fields]);
        audit_(user, 'INGREDIENT_CREATE', 'Ingredient', id, { name: name, group: group, base: base });
      }
      clearRecipeCache_();
      return { id: id };
    });
  });
}

// ---------------- Recipes API ----------------

function apiGetRecipes(token, group) {
  return run_(function () {
    const user = requireSession_(token);
    group = String(group || '').toUpperCase();
    if (group !== 'FOOD' && group !== 'BEVERAGE') throw new Error('Grup resep tidak dikenal.');
    if (!canRecipe_(user, group, 'view')) throw jayaError_('Akses ditolak. Role Anda tidak boleh melihat resep ' + groupWord_(group) + '.', 'DENIED');
    const data = recipeData_();
    const products = readTable_('Products').rows.filter(function (r) {
      return String(r.Recipe_Group || '').trim().toUpperCase() === group && isTrue_(r.Active) && String(r.Product_ID).trim();
    }).map(function (r) {
      const id = String(r.Product_ID).trim();
      const price = moneyNum_(r.Selling_Price) || 0;
      const rc = data.recipes[id] || null;
      const cost = rc ? rc.perServing : (moneyNum_(r.Cost) || 0);
      return {
        id: id, name: String(r.Product_Name).trim(), category: String(r.Category).trim(), price: price,
        recipe: rc ? { recipeId: rc.recipeId, yieldQty: rc.yieldQty, notes: rc.notes, lines: rc.lines, totalCost: rc.totalCost,
                       perServing: rc.perServing, problems: rc.problems, updatedAt: rc.updatedAt, updatedBy: rc.updatedBy } : null,
        cost: cost, costPct: price > 0 ? Math.round(cost / price * 1000) / 10 : null
      };
    });
    const ingredients = Object.keys(data.ingredients).map(function (k) { return data.ingredients[k]; })
      .filter(function (i) { return i.active && (i.group === group || i.group === 'SHARED'); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .map(function (i) { return { id: i.id, name: i.name, baseUnit: i.baseUnit, cost: round4_(i.cost), group: i.group }; });
    return { group: group, canEdit: canRecipe_(user, group, 'edit'), products: products, ingredients: ingredients, units: publicUnits_() };
  });
}

function apiSaveRecipe(token, d) {
  return run_(function () {
    const user = requireSession_(token);
    d = d || {};
    const prod = readTable_('Products').rows.filter(function (r) { return String(r.Product_ID).trim() === String(d.productId || ''); })[0];
    if (!prod) throw new Error('Produk tidak ditemukan.');
    const group = String(prod.Recipe_Group || '').trim().toUpperCase();
    if (!canRecipe_(user, group, 'edit')) throw jayaError_('Akses ditolak. Role Anda tidak boleh mengubah resep ' + (groupWord_(group) || 'ini') + '.', 'DENIED');
    const yieldQty = Number(d.yieldQty);
    if (!isFinite(yieldQty) || yieldQty <= 0 || yieldQty > 1000) throw new Error('Hasil (jumlah porsi) harus angka di atas 0.');
    if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('Tambahkan minimal satu bahan.');
    if (d.lines.length > 60) throw new Error('Bahan terlalu banyak (maks. 60).');
    const ings = {};
    ingredientsList_().forEach(function (i) { ings[i.id] = i; });
    const seen = {};
    const lines = d.lines.map(function (l, idx) {
      const ing = ings[String(l && l.ingredientId || '')];
      if (!ing || !ing.active) throw new Error('Baris ' + (idx + 1) + ': pilih bahan.');
      if (!hasPerm_(user, '*') && ing.group !== group && ing.group !== 'SHARED') {
        throw new Error(ing.name + ' adalah bahan ' + groupWord_(ing.group) + ' dan tidak bisa dipakai di resep ' + groupWord_(group) + '.');
      }
      if (seen[ing.id]) throw new Error(ing.name + ' muncul dua kali. Tulis jumlah totalnya di satu baris.');
      seen[ing.id] = true;
      const qty = Number(l.qty);
      if (!isFinite(qty) || qty <= 0 || qty > 1000000) throw new Error(ing.name + ': jumlah harus di atas 0.');
      const unit = String(l.unit || '').toLowerCase();
      convertQty_(qty, unit, ing.baseUnit);   // throws for impossible conversions (e.g. g -> ml)
      const unitCost = ing.cost * UNITS[unit].factor;
      return { ing: ing, qty: qty, unit: unit, unitCost: round4_(unitCost), cost: Math.round(qty * unitCost) };
    });
    const notes = cleanText_(d.notes, 300);

    return withLock_(function () {
      const data = recipeData_();
      const existing = data.recipes[String(d.productId)];
      const stamp = nowStamp_();
      let recipeId;
      const fields = { Product_ID: String(d.productId), Recipe_Name: String(prod.Product_Name), Recipe_Group: group,
                       Yield_Quantity: yieldQty, Yield_Unit: 'portion', Active_Status: true, Updated_At: stamp,
                       Updated_By: user.name, Notes: notes };
      if (existing) {
        recipeId = existing.recipeId;
        updateRow_('Recipes', existing.row, fields);
        deleteRowsWhere_('Recipe_Details', 'Recipe_ID', recipeId);
      } else {
        recipeId = nextId_(readTable_('Recipes').rows.map(function (r) { return r.Recipe_ID; }), 'R', 3);
        fields.Recipe_ID = recipeId;
        appendObjects_('Recipes', [fields]);
      }
      appendObjects_('Recipe_Details', lines.map(function (l, i) {
        return { Recipe_ID: recipeId, Ingredient_ID: l.ing.id, Quantity_Required: l.qty, Unit: l.unit,
                 Cost_Per_Unit: l.unitCost, Ingredient_Cost: l.cost, Line_No: i + 1 };
      }));
      const fresh = recipeData_();
      refreshProductCosts_(fresh);
      const rc = fresh.recipes[String(d.productId)];
      audit_(user, existing ? 'RECIPE_UPDATE' : 'RECIPE_CREATE', 'Recipe', recipeId, {
        product: String(prod.Product_Name), yield: yieldQty, perServing: rc ? rc.perServing : 0,
        before: existing ? existing.lines.map(function (l) { return l.name + ' ' + l.qty + l.unit; }) : [],
        after: lines.map(function (l) { return l.ing.name + ' ' + l.qty + l.unit; })
      });
      return { recipeId: recipeId, perServing: rc ? rc.perServing : 0 };
    });
  });
}

function apiDeleteRecipe(token, productId) {
  return run_(function () {
    const user = requireSession_(token);
    return withLock_(function () {
      const data = recipeData_();
      const rc = data.recipes[String(productId)];
      if (!rc) throw new Error('Produk ini belum punya resep.');
      const prod = readTable_('Products').rows.filter(function (r) { return String(r.Product_ID).trim() === String(productId); })[0];
      const group = prod ? String(prod.Recipe_Group || '').trim().toUpperCase() : '';
      if (!canRecipe_(user, group, 'edit')) throw jayaError_('Akses ditolak.', 'DENIED');
      updateRow_('Recipes', rc.row, { Active_Status: false, Updated_At: nowStamp_(), Updated_By: user.name });
      clearRecipeCache_();
      audit_(user, 'RECIPE_DELETE', 'Recipe', rc.recipeId, { product: prod ? String(prod.Product_Name) : productId });
      return true;
    });
  });
}

// ---------------- Stock API ----------------

/** Reads only the last part of a long sheet (newest rows). */
function readRecentRows_(name, maxRows) {
  const sh = getSheet_(name);
  const headers = getHeaders_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const start = Math.max(2, lastRow - maxRows + 1);
  return sh.getRange(start, 1, lastRow - start + 1, headers.length).getValues().map(function (r, i) {
    const o = { _row: start + i };
    headers.forEach(function (h, j) { if (h) o[h] = r[j]; });
    return o;
  });
}

function apiGetStock(token, group) {
  return run_(function () {
    const user = requireSession_(token);
    group = String(group || 'ALL').toUpperCase();
    const groups = group === 'ALL' ? INGREDIENT_GROUPS : [group, 'SHARED'];
    if (group === 'ALL' ? !(hasPerm_(user, '*') || hasPerm_(user, 'inventory.view')) : !canStock_(user, group, 'view')) {
      throw jayaError_('Akses ditolak. Role Anda tidak boleh melihat stok ini.', 'DENIED');
    }
    const list = ingredientsList_().filter(function (i) { return i.active && groups.indexOf(i.group) >= 0; });
    const ids = {};
    list.forEach(function (i) { ids[i.id] = true; });
    const movements = readRecentRows_('Inventory_Movements', 1500)
      .filter(function (m) { return ids[String(m.Ingredient_ID).trim()]; })
      .reverse().slice(0, 60)
      .map(function (m) {
        return { id: String(m.Movement_ID), when: cellText_(m.Timestamp), ingredient: String(m.Ingredient_Name || m.Ingredient_ID),
                 type: String(m.Movement_Type), qtyBase: numOr_(m.Quantity_Base, 0), unit: String(m.Unit || ''),
                 cost: moneyNum_(m.Total_Cost) || 0, ref: String(m.Reference_ID || ''), notes: String(m.Notes || '') };
      });
    return {
      group: group,
      ingredients: list.sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (i) {
        return { id: i.id, name: i.name, group: i.group, baseUnit: i.baseUnit, stock: i.stock, minStock: i.minStock,
                 cost: round4_(i.cost), value: Math.round(Math.max(0, i.stock) * i.cost), purchaseUnit: i.purchaseUnit,
                 purchaseToBase: i.purchaseToBase, low: i.minStock > 0 && i.stock < i.minStock,
                 canWaste: canStock_(user, i.group, 'waste') };
      }),
      movements: movements,
      canAdjust: hasPerm_(user, '*'),
      units: publicUnits_()
    };
  });
}

function apiRecordWaste(token, d) {
  return run_(function () {
    const user = requireSession_(token);
    d = d || {};
    return withLock_(function () {
      const ing = ingredientsList_().filter(function (i) { return i.id === String(d.ingredientId || ''); })[0];
      if (!ing) throw new Error('Bahan tidak ditemukan.');
      if (!canStock_(user, ing.group, 'waste')) throw jayaError_('Akses ditolak. Role Anda tidak boleh mencatat waste bahan ' + groupWord_(ing.group) + '.', 'DENIED');
      const qty = Number(d.qty);
      if (!isFinite(qty) || qty <= 0 || qty > 1000000) throw new Error('Jumlah harus di atas 0.');
      const unit = String(d.unit || ing.baseUnit).toLowerCase();
      const base = convertQty_(qty, unit, ing.baseUnit);
      const reason = cleanText_(d.reason, 120);
      if (!reason) throw new Error('Tulis alasan singkat (contoh: basi, jatuh, makan staf).');
      applyMovements_([{ ing: ing, type: 'WASTE', qty: -qty, unit: unit, baseQty: -base, unitCost: ing.cost, notes: reason }], user, {});
      audit_(user, 'STOCK_WASTE', 'Ingredient', ing.id, { name: ing.name, qty: qty, unit: unit, reason: reason, cost: Math.round(base * ing.cost) });
      return true;
    });
  });
}

/** Admin: set the counted stock (and optionally the cost) of an ingredient. */
function apiAdjustStock(token, d) {
  return run_(function () {
    const user = requirePerm_(token, 'inventory.adjust');
    d = d || {};
    return withLock_(function () {
      const ing = ingredientsList_().filter(function (i) { return i.id === String(d.ingredientId || ''); })[0];
      if (!ing) throw new Error('Bahan tidak ditemukan.');
      const counted = Number(d.countedQty);
      if (!isFinite(counted) || counted < 0 || counted > 100000000) throw new Error('Stok hasil hitung harus 0 atau lebih (dalam ' + ing.baseUnit + ').');
      const costUpdates = {};
      let cost = ing.cost;
      if (d.costPerPurchaseUnit !== null && d.costPerPurchaseUnit !== undefined && d.costPerPurchaseUnit !== '') {
        const cpu = Number(d.costPerPurchaseUnit);
        if (!isFinite(cpu) || cpu < 0) throw new Error('Harga pokok harus 0 atau lebih.');
        cost = cpu / ing.purchaseToBase;
        costUpdates[ing.id] = { cost: cost };
      }
      const delta = round4_(counted - ing.stock);
      const reason = cleanText_(d.reason, 120) || 'Stock opname';
      const type = ing.stock === 0 && ing.cost === 0 ? 'OPENING' : 'ADJUST';
      const moves = delta !== 0 ? [{ ing: ing, type: type, qty: delta, unit: ing.baseUnit, baseQty: delta, unitCost: cost, notes: reason }] : [];
      applyMovements_(moves, user, costUpdates);
      if (costUpdates[ing.id]) refreshProductCosts_();
      audit_(user, 'STOCK_ADJUST', 'Ingredient', ing.id, { name: ing.name, from: ing.stock, to: counted, costPerBase: round4_(cost), reason: reason });
      return true;
    });
  });
}
