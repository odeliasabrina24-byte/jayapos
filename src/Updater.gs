/**
 * Updater.gs
 * JayaPOS is updated automatically from GitHub (odeliasabrina24-byte/jayapos):
 * every change in src/ is pushed to this Apps Script project and deployed by GitHub Actions (clasp),
 * so the web app link (/exec) stays the same and phones only need to reopen JayaPOS.
 *
 * autoMigrate_(): the first time a new version opens, the database setup runs once by itself
 * (new sheets, columns and settings are added; nothing is deleted).
 */

function autoMigrate_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === APP_VERSION) return false;
  if (!props.getProperty('SPREADSHEET_ID')) return false;    // never set up: the owner runs Setup from the Sheet
  return withLock_(function () {
    if (props.getProperty('SCHEMA_VERSION') === APP_VERSION) return false;
    setupDatabase_();
    try { importMenuOnce_(); } catch (e) { console.error('importMenuOnce_: ' + e); }
    return true;
  });
}

// ---------------- One-time menu import (real Babi Jaya Bali & Kopi Jaya Bali menu, Oct 2026) ----------------

const MENU_IMPORT_KEY = 'BKJ-MENU-2026-10-07';
/** [name, category, price, recipe group] */
const MENU_BKJ = [
  ['Babi Kailan', 'Makanan', 55000, 'FOOD'],
  ['Babi Kecap', 'Makanan', 60000, 'FOOD'],
  ['Babi Jaya (Babi Crispy)', 'Makanan', 67000, 'FOOD'],
  ['Espresso', 'Classic Coffee', 15000, 'BEVERAGE'],
  ['Double Espresso', 'Classic Coffee', 20000, 'BEVERAGE'],
  ['Hot Americano', 'Classic Coffee', 23000, 'BEVERAGE'],
  ['Iced Americano', 'Classic Coffee', 25000, 'BEVERAGE'],
  ['Hot Cafe Latte', 'Classic Coffee', 25000, 'BEVERAGE'],
  ['Iced Cafe Latte', 'Classic Coffee', 27000, 'BEVERAGE'],
  ['Hot Cappuccino', 'Classic Coffee', 25000, 'BEVERAGE'],
  ['Iced Cappuccino', 'Classic Coffee', 27000, 'BEVERAGE'],
  ['Americano Berry & Lychee', 'Chosen Coffee', 33000, 'BEVERAGE'],
  ['Mont Blanc', 'Chosen Coffee', 35000, 'BEVERAGE'],
  ['Coconut Cloud Coffee', 'Chosen Coffee', 35000, 'BEVERAGE'],
  ['Avocado Cafe Latte', 'Chosen Coffee', 42000, 'BEVERAGE'],
  ['Butterscotch Seasalt Latte', 'Chosen Coffee', 35000, 'BEVERAGE'],
  ['Seasalt Honey Cream Matcha', 'Chosen Coffee', 35000, 'BEVERAGE'],
  ['Matcha Seasalt Cream', 'Chosen Coffee', 35000, 'BEVERAGE'],
  ['Sparkling Peach Coffee', 'Chosen Coffee', 35000, 'BEVERAGE'],
  ['Vanilla Milkshake', 'Milk Shake', 37000, 'BEVERAGE'],
  ['Strawberry Milkshake', 'Milk Shake', 37000, 'BEVERAGE'],
  ['Chocolate Milkshake', 'Milk Shake', 37000, 'BEVERAGE'],
  ['Oreo Milkshake', 'Milk Shake', 37000, 'BEVERAGE'],
  ['Mineral Water', 'Non Coffee', 15000, 'NONE'],
  ['Hot Tea', 'Non Coffee', 15000, 'BEVERAGE'],
  ['Iced Tea', 'Non Coffee', 17000, 'BEVERAGE'],
  ['Iced Lemon Tea', 'Non Coffee', 19000, 'BEVERAGE'],
  ['Iced Lychee Tea', 'Non Coffee', 25000, 'BEVERAGE'],
  ['Syrup Vanilla', 'Add-ons', 10000, 'BEVERAGE'],
  ['Syrup Hazelnut', 'Add-ons', 10000, 'BEVERAGE'],
  ['Syrup Caramel', 'Add-ons', 10000, 'BEVERAGE'],
  ['Syrup Pistachio', 'Add-ons', 10000, 'BEVERAGE']
];
const MENU_BKJ_CATEGORY_ORDER = 'Makanan,Classic Coffee,Chosen Coffee,Milk Shake,Non Coffee,Add-ons';

/**
 * Runs once: the sample products from the first setup are switched off (kept for history, Active = FALSE),
 * the real menu is added, and products with the same name are updated (price, category, active).
 * Products you added yourself are not touched.
 */
function importMenuOnce_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('MENU_IMPORT') === MENU_IMPORT_KEY) return false;
  const rows = readTable_('Products').rows;
  const key = function (n) { return String(n || '').trim().toLowerCase(); };
  const byName = {};
  rows.forEach(function (r) { byName[key(r.Product_Name)] = r; });
  const menuNames = MENU_BKJ.map(function (m) { return key(m[0]); });
  const stamp = nowStamp_();
  const off = {};
  SAMPLE_PRODUCTS.forEach(function (p) {
    const r = byName[key(p[1])];
    if (r && menuNames.indexOf(key(p[1])) < 0 && isTrue_(r.Active)) off[r._row] = false;
  });
  setColumnValues_('Products', 'Active', off);
  const ids = rows.map(function (r) { return String(r.Product_ID).trim(); });
  const add = [];
  let updated = 0;
  MENU_BKJ.forEach(function (m) {
    const r = byName[key(m[0])];
    if (r) {
      updateRow_('Products', r._row, { Category: m[1], Selling_Price: m[2], Active: true, Recipe_Group: m[3], Updated_At: stamp });
      updated++;
      return;
    }
    const id = nextId_(ids, 'P', 3);
    ids.push(id);
    add.push({ Product_ID: id, Product_Name: m[0], Category: m[1], Selling_Price: m[2], Cost: 0, Active: true,
               Recipe_Group: m[3], Updated_At: stamp, Image_URL: '' });
  });
  appendObjects_('Products', add);
  const order = readTable_('Settings').rows.filter(function (r) { return String(r.Setting).trim() === 'Category_Order'; })[0];
  const defOrder = SETTINGS_DEFAULTS.filter(function (d) { return d[0] === 'Category_Order'; })[0][1];
  if (order && cellText_(order.Value) === defOrder) updateRow_('Settings', order._row, { Value: MENU_BKJ_CATEGORY_ORDER });
  SETTINGS_CACHE_ = null;
  props.setProperty('MENU_IMPORT', MENU_IMPORT_KEY);
  audit_(null, 'MENU_IMPORT', 'Products', MENU_IMPORT_KEY, { added: add.length, updated: updated, switchedOff: Object.keys(off).length });
  return true;
}
