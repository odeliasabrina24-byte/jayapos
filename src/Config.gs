/**
 * Config.gs
 * Everything JayaPOS needs that is NOT stored in the Google Sheet:
 * sheet layouts, roles, permissions, menu, payment methods, units.
 * You normally do not need to edit this file.
 */

const APP_VERSION = '3.4.2';

// A login lasts up to 6 hours after the LAST action (Google's cache limit).
const SESSION_SECONDS = 21600;
const MAX_PIN_FAILS = 5;       // wrong PINs in a row before a username is locked...
const PIN_LOCK_SECONDS = 300;  // ...for 5 minutes

const PAYMENT_METHODS = {
  CASH: 'Tunai',
  QRIS: 'QRIS',
  DEBIT: 'Debit',
  CREDIT_CARD: 'Kartu Kredit',
  OTHER: 'Lainnya'
};
/** Label for a bill paid with more than one method (split bill). Stored as Payment_Method = MIXED. */
const MIXED_LABEL = 'Campuran';
/** Order of the payment buttons on the POS (an object's key order is not kept when sent to the phone). */
const PAYMENT_ORDER = ['CASH', 'QRIS', 'DEBIT', 'CREDIT_CARD', 'OTHER'];

/** How roles and statuses are shown in the app (the codes in the Sheet stay in English). */
const ROLE_LABELS = { ADMIN: 'Admin', OWNER: 'Owner', CASHIER: 'Kasir', CHEF: 'Chef', BARISTA: 'Barista',
                      PURCHASING: 'Purchasing' };

const ROLES = ['ADMIN', 'OWNER', 'CASHIER', 'CHEF', 'BARISTA', 'PURCHASING'];

/**
 * Each person has ONE main role (Role) and may get extra roles (Extra_Roles)
 * and single extra permissions (Extra_Perms). Their access is the union of all of them.
 * Old role SERVER is now CASHIER (see normRole_ in Auth.gs).
 */
const EXTRA_ROLES = ROLES.slice();
const EXTRA_PERMS = ['tables.serve', 'kitchen.food', 'kitchen.bar', 'pos.sell', 'pos.order', 'menu.soldout'];
const PERM_LABELS = {
  'tables.serve': 'Antar pesanan', 'kitchen.food': 'Layar Dapur', 'kitchen.bar': 'Layar Bar',
  'pos.sell': 'Bayar', 'pos.order': 'Catat pesanan', 'menu.soldout': 'Menu Habis'
};

/**
 * Staff roles agreed for this business. Applied ONCE to the Users sheet
 * (see applyStaffRolesOnce_ in Database.gs). Matched by Username, or by the first word of Full_Name.
 */
const STAFF_ROLES = {
  patrick: { role: 'OWNER',      extraRoles: [],        extraPerms: [] },
  odelia:  { role: 'OWNER',      extraRoles: ['ADMIN'], extraPerms: [] },
  kevin:   { role: 'BARISTA',    extraRoles: ['CASHIER'], extraPerms: [] },
  sendy:   { role: 'CASHIER',    extraRoles: [],        extraPerms: [] },
  wisnu:   { role: 'PURCHASING', extraRoles: [],        extraPerms: ['tables.serve'] },
  rian:    { role: 'CHEF',       extraRoles: [],        extraPerms: [] },
  reza:    { role: 'CHEF',       extraRoles: [],        extraPerms: [] }
};

/**
 * What each role may do. The server checks these on every request,
 * so hiding a button is never the only protection. '*' = everything.
 */
const ROLE_PERMISSIONS = {
  ADMIN:      ['*'],
  OWNER:      ['dashboard.view', 'history.view_all', 'receipt.view', 'products.view', 'products.view_cost',
               'reports.view', 'purchasing.view', 'inventory.view', 'suppliers.view', 'notifications.view',
               'shift.view', 'cash.confirm'],
  CASHIER:    ['pos.sell', 'pos.order', 'tables.serve', 'tables.layout', 'history.view_recent', 'receipt.view', 'pos.void',
               'shift.manage', 'menu.soldout'],
  CHEF:       ['kitchen.food', 'menu.soldout', 'recipes.food', 'cogs.food', 'stock.food', 'ingredients.food'],
  BARISTA:    ['kitchen.bar', 'menu.soldout', 'recipes.beverage', 'cogs.beverage', 'stock.beverage', 'ingredients.beverage'],
  PURCHASING: ['suppliers.manage', 'suppliers.view', 'purchasing.manage', 'purchasing.view', 'ingredients.purchasing']
};

/**
 * Menu items. ready:true = working in this version.
 * ready:false = planned; shown greyed out with its phase, never as a finished page.
 */
const NAV = [
  { id: 'home',             section: 'Penjualan',    label: 'Beranda',           perms: ['pos.sell'], ready: true },
  { id: 'pos',              section: 'Penjualan',    label: 'Kasir (POS)',       perms: ['pos.sell', 'pos.order'], ready: true },
  { id: 'tables',           section: 'Penjualan',    label: 'Meja',            perms: ['tables.serve', 'tables.layout'], ready: true },
  { id: 'serve',            section: 'Penjualan',    label: 'Siap Diantar',      perms: ['tables.serve'], ready: true },
  { id: 'shift',            section: 'Penjualan',    label: 'Kas & Shift',       perms: ['shift.manage', 'shift.view'], ready: true },
  { id: 'soldout',          section: 'Penjualan',    label: 'Menu Habis',        perms: ['menu.soldout'], ready: true },
  { id: 'history',          section: 'Penjualan',    label: 'Riwayat Penjualan',     perms: ['history.view_all', 'history.view_recent'], ready: true },
  { id: 'notifications',    section: 'Penjualan',    label: 'Notifikasi',        perms: ['notifications.view'], ready: true },
  { id: 'dashboard',        section: 'Penjualan',    label: 'Dashboard',         perms: ['dashboard.view'], ready: true },

  { id: 'kitchen',          section: 'Dapur',        label: 'Layar Dapur',       perms: ['kitchen.food'], ready: true },
  { id: 'food_recipes',     section: 'Dapur',        label: 'Resep Makanan',      perms: ['recipes.food'], ready: true },
  { id: 'food_cogs',        section: 'Dapur',        label: 'HPP Makanan',         perms: ['cogs.food'], ready: true },
  { id: 'food_stock',       section: 'Dapur',        label: 'Stok Dapur',        perms: ['stock.food'], ready: true },
  { id: 'bar_orders',       section: 'Bar',          label: 'Layar Bar',         perms: ['kitchen.bar'], ready: true },
  { id: 'bev_recipes',      section: 'Bar',          label: 'Resep Minuman',  perms: ['recipes.beverage'], ready: true },
  { id: 'bev_cogs',         section: 'Bar',          label: 'HPP Minuman',     perms: ['cogs.beverage'], ready: true },
  { id: 'bev_stock',        section: 'Bar',          label: 'Stok Bar',    perms: ['stock.beverage'], ready: true },
  { id: 'ingredients',      section: 'Gudang',       label: 'Bahan Baku',       perms: ['ingredients.food', 'ingredients.beverage', 'ingredients.purchasing', 'inventory.view'], ready: true },

  { id: 'suppliers',        section: 'Pembelian',    label: 'Supplier',         perms: ['suppliers.manage', 'suppliers.view'], ready: true },
  { id: 'purchase_orders',  section: 'Pembelian',    label: 'Purchase Order (PO)',   perms: ['purchasing.manage'], ready: true },
  { id: 'goods_receiving',  section: 'Pembelian',    label: 'Penerimaan Barang',   perms: ['purchasing.manage'], ready: true },
  { id: 'purchase_history', section: 'Pembelian',    label: 'Riwayat Pembelian',  perms: ['purchasing.view', 'purchasing.manage'], ready: true },

  { id: 'sales_reports',    section: 'Laporan',      label: 'Laporan Penjualan',     perms: ['reports.view'], ready: true },
  { id: 'cogs_reports',     section: 'Laporan',      label: 'Laporan HPP',      perms: ['reports.view'], ready: true },
  { id: 'profit_reports',   section: 'Laporan',      label: 'Laporan Laba',     perms: ['reports.view'], ready: true },
  { id: 'purchasing_reports', section: 'Laporan',    label: 'Laporan Pembelian', perms: ['reports.view'], ready: true },
  { id: 'inventory_reports', section: 'Laporan',     label: 'Laporan Stok', perms: ['inventory.view'], ready: true },

  { id: 'products',         section: 'Admin',        label: 'Produk',          perms: ['products.view'], ready: true },
  { id: 'users',            section: 'Admin',        label: 'Pengguna',             perms: ['users.manage'], ready: true },
  { id: 'settings',         section: 'Admin',        label: 'Pengaturan',          perms: ['settings.manage'], ready: true }
];

/**
 * Settings sheet defaults: [Setting, Value, Description].
 * Setup adds any missing ones; it never overwrites your values.
 */
const SETTINGS_DEFAULTS = [
  ['Business_Name', 'Babi Kopi Jaya Bali', 'Nama usaha di bagian atas struk'],
  ['App_Name', 'JayaPOS', 'Nama aplikasi'],
  ['Outlet_ID', 'BKJ-01', 'Kode outlet (untuk multi-outlet nanti)'],
  ['Receipt_Address', '', 'Alamat di struk (boleh kosong)'],
  ['Receipt_Phone', '', 'Telepon / Instagram di struk (boleh kosong)'],
  ['Receipt_Footer', 'Terima Kasih', 'Baris terakhir di struk'],
  ['Receipt_Width_mm', '58', 'Lebar kertas struk: 58 atau 80'],
  ['Tx_Prefix', 'JY', 'Awalan nomor transaksi (huruf saja), contoh JY-20261006-0001'],
  ['Category_Order', 'Crispy Pork,Food,Coffee,Non-Coffee,Drinks,Add-ons', 'Urutan tab kategori di kasir, dipisah koma'],
  ['Cashier_History_Days', '2', 'Berapa hari riwayat penjualan yang bisa dilihat kasir (2 = hari ini + kemarin)'],
  ['Allow_Discount', 'TRUE', 'TRUE = kasir boleh memberi diskon; FALSE = hanya admin'],
  ['Max_Discount_Percent', '100', 'Batas diskon kasir dalam % (berlaku untuk diskon item dan diskon bill). Admin tidak dibatasi'],
  ['Service_Percent', '5', 'Service charge dalam %, ditambahkan di atas harga. 0 = tanpa service'],
  ['Service_Label', 'Service', 'Nama service charge di struk'],
  ['Service_On_Takeaway', 'FALSE', 'TRUE = pesanan takeaway juga otomatis kena service'],
  ['Tax_Percent', '10', 'Pajak dalam %, dihitung dari (subtotal - diskon + service). 0 = tanpa pajak'],
  ['Tax_Label', 'PB1', 'Nama pajak di struk'],
  ['Tax_On_Takeaway', 'TRUE', 'TRUE = pesanan takeaway otomatis kena pajak (kasir tetap bisa hilangkan centangnya)'],
  ['Cash_Rounding', '1000', 'Pembulatan pembayaran TUNAI ke kelipatan ini (Rp). 0 = tanpa pembulatan'],
  ['Cash_Rounding_Mode', 'NEAREST', 'NEAREST = ke ribuan terdekat, DOWN = selalu ke bawah, UP = selalu ke atas'],
  ['Show_Product_Images', 'TRUE', 'TRUE = tampilkan foto produk di kasir'],
  ['Table_Areas', 'Indoor,Outdoor', 'Area denah meja (tab di layar Meja), dipisah koma'],
  ['Costing_Method', 'AVERAGE', 'Cara update harga pokok bahan saat barang datang: AVERAGE (rata-rata tertimbang) atau LAST (harga terakhir)'],
  ['Deduct_Stock_On_Sale', 'TRUE', 'TRUE = setiap penjualan otomatis mengurangi stok bahan sesuai resep'],
  ['Cashier_Void_Days', '1', 'Berapa hari ke belakang kasir boleh void transaksi yang sudah dibayar (1 = hanya hari ini). Admin tidak dibatasi'],
  ['Modifier_Category', 'Add-ons', 'Kategori produk tambahan (contoh syrup +10rb). Tidak tampil sebagai menu sendiri; dipilih lewat tombol "+ Tambahan" di baris minuman/makanan dengan grup resep yang sama'],
  ['Quick_Notes', 'Pedas,Tidak pedas,Extra pedas,Es pisah,Tanpa es,Less ice,Less sugar,Tanpa bawang,Bungkus', 'Tombol catatan cepat untuk dapur/bar saat input pesanan, dipisah koma'],
  ['Require_Shift', 'TRUE', 'TRUE = pembayaran hanya bisa diterima kalau shift kas sudah dibuka (modal awal sudah dihitung)'],
  ['Max_Cash_In_Drawer', '2000000', 'Kalau uang tunai di laci melebihi angka ini, kasir diingatkan untuk setor. 0 = tanpa pengingat'],
  ['Cash_Diff_Tolerance', '0', 'Selisih kas (Rp) yang masih dianggap wajar saat tutup shift. Selisih lebih besar ditandai merah di notifikasi']
];

/** Short Indonesian names for the Settings screen. */
const SETTING_LABELS = {
  Business_Name: 'Nama usaha', App_Name: 'Nama aplikasi', Outlet_ID: 'Kode outlet', Receipt_Address: 'Alamat di struk',
  Receipt_Phone: 'Telepon di struk', Receipt_Footer: 'Penutup struk', Receipt_Width_mm: 'Lebar struk (mm)',
  Tx_Prefix: 'Awalan nomor transaksi', Category_Order: 'Urutan kategori', Cashier_History_Days: 'Riwayat untuk kasir (hari)',
  Allow_Discount: 'Kasir boleh diskon', Max_Discount_Percent: 'Batas diskon kasir (%)', Service_Percent: 'Service (%)',
  Service_Label: 'Nama service', Service_On_Takeaway: 'Service untuk takeaway', Tax_Percent: 'Pajak (%)',
  Tax_Label: 'Nama pajak', Tax_On_Takeaway: 'Pajak untuk takeaway', Cash_Rounding: 'Pembulatan tunai (Rp)',
  Cash_Rounding_Mode: 'Cara pembulatan', Show_Product_Images: 'Tampilkan foto produk', Table_Areas: 'Area meja',
  Costing_Method: 'Metode harga pokok', Deduct_Stock_On_Sale: 'Kurangi stok saat terjual',
  Cashier_Void_Days: 'Batas void kasir (hari)', Quick_Notes: 'Catatan cepat (dapur/bar)', Modifier_Category: 'Kategori tambahan (syrup dll.)', Require_Shift: 'Wajib buka shift',
  Max_Cash_In_Drawer: 'Batas uang di laci (Rp)', Cash_Diff_Tolerance: 'Toleransi selisih kas (Rp)'
};

/** Rupiah notes and coins counted when a shift is opened / closed. */
const CASH_DENOMS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100];

const SAMPLE_PRODUCTS = [
  ['P001', 'Crispy Pork', 'Crispy Pork', 45000, 20000, 'FOOD'],
  ['P002', 'Crispy Pork Rice', 'Crispy Pork', 55000, 24000, 'FOOD'],
  ['P003', 'Babi Kecap Rice', 'Food', 50000, 22000, 'FOOD'],
  ['P004', 'Nasi Campur Babi', 'Food', 60000, 28000, 'FOOD'],
  ['P005', 'Espresso', 'Coffee', 20000, 7000, 'BEVERAGE'],
  ['P006', 'Americano', 'Coffee', 25000, 8000, 'BEVERAGE'],
  ['P007', 'Iced Coffee', 'Coffee', 25000, 10000, 'BEVERAGE'],
  ['P008', 'Cafe Latte', 'Coffee', 32000, 12000, 'BEVERAGE'],
  ['P009', 'Iced Tea', 'Non-Coffee', 18000, 5000, 'BEVERAGE'],
  ['P010', 'Matcha Latte', 'Non-Coffee', 35000, 14000, 'BEVERAGE'],
  ['P011', 'Mineral Water', 'Drinks', 10000, 4000, 'NONE'],
  ['P012', 'Soft Drink', 'Drinks', 15000, 7000, 'NONE'],
  ['P013', 'Extra Rice', 'Add-ons', 8000, 3000, 'FOOD'],
  ['P014', 'Extra Sambal', 'Add-ons', 5000, 1500, 'FOOD'],
  ['P015', 'Extra Shot', 'Add-ons', 8000, 3000, 'BEVERAGE']
];

/** [ID, Name, Area, Seats, Shape, X%, Y%, Width%, Height%] — a starting layout you can drag around. */
const SAMPLE_TABLES = [
  ['T01', 'T1', 'Indoor', 2, 'SQUARE', 6, 6, 18, 18],
  ['T02', 'T2', 'Indoor', 2, 'SQUARE', 30, 6, 18, 18],
  ['T03', 'T3', 'Indoor', 4, 'SQUARE', 54, 6, 18, 18],
  ['T04', 'T4', 'Indoor', 4, 'SQUARE', 78, 6, 18, 18],
  ['T05', 'T5', 'Indoor', 4, 'ROUND', 6, 40, 20, 20],
  ['T06', 'T6', 'Indoor', 4, 'ROUND', 40, 40, 20, 20],
  ['T07', 'T7', 'Indoor', 8, 'RECT', 6, 74, 40, 18],
  ['T08', 'T8', 'Indoor', 6, 'RECT', 54, 74, 40, 18],
  ['T09', 'O1', 'Outdoor', 4, 'ROUND', 8, 8, 22, 22],
  ['T10', 'O2', 'Outdoor', 4, 'ROUND', 40, 8, 22, 22],
  ['T11', 'O3', 'Outdoor', 4, 'ROUND', 72, 8, 22, 22],
  ['T12', 'O4', 'Outdoor', 6, 'RECT', 20, 50, 40, 18]
];

const TABLE_SHAPES = ['SQUARE', 'ROUND', 'RECT'];
const RECIPE_GROUPS = ['FOOD', 'BEVERAGE', 'NONE'];
const INGREDIENT_GROUPS = ['FOOD', 'BEVERAGE', 'SHARED'];
const BASE_UNITS = ['g', 'ml', 'pcs', 'portion'];
const MOVEMENT_TYPES = ['OPENING', 'PURCHASE', 'SALE', 'WASTE', 'ADJUST', 'VOID'];
const CASH_MOVE_TYPES = ['CASH_IN', 'CASH_OUT', 'SETOR'];

/**
 * Units for recipes/inventory (Phase 2-3). Every unit converts to one base unit.
 * Converting between different bases (e.g. g -> ml) is refused.
 */
const UNITS = {
  g:       { base: 'g', factor: 1 },
  kg:      { base: 'g', factor: 1000 },
  ml:      { base: 'ml', factor: 1 },
  l:       { base: 'ml', factor: 1000 },
  pcs:     { base: 'pcs', factor: 1 },
  portion: { base: 'portion', factor: 1 }
};

/**
 * Sheet layouts. text = stored as plain text (no auto date conversion).
 * money = shown with thousands separators. lists = dropdown choices in the Sheet.
 * planned = used in later phases.
 */
const SCHEMA = {
  Settings: {
    headers: ['Setting', 'Value', 'Description'],
    text: ['Setting', 'Value', 'Description']
  },
  Users: {
    headers: ['User_ID', 'Full_Name', 'Username', 'Role', 'New_PIN', 'Active_Status', 'PIN_Hash', 'PIN_Salt',
              'Created_At', 'Updated_At', 'Extra_Roles', 'Extra_Perms'],
    text: ['User_ID', 'Full_Name', 'Username', 'Role', 'New_PIN', 'PIN_Hash', 'PIN_Salt', 'Created_At', 'Updated_At',
           'Extra_Roles', 'Extra_Perms'],
    lists: { Role: ROLES, Active_Status: ['TRUE', 'FALSE'] }
  },
  Products: {
    headers: ['Product_ID', 'Product_Name', 'Category', 'Selling_Price', 'Cost', 'Active', 'Recipe_Group', 'Updated_At',
              'Image_URL', 'Sold_Out', 'Sold_Out_By', 'Sold_Out_At'],
    text: ['Product_ID', 'Product_Name', 'Category', 'Recipe_Group', 'Updated_At', 'Image_URL', 'Sold_Out_By', 'Sold_Out_At'],
    money: ['Selling_Price', 'Cost'],
    lists: { Active: ['TRUE', 'FALSE'], Recipe_Group: RECIPE_GROUPS, Sold_Out: ['TRUE', 'FALSE'] }
  },
  Tables: {
    headers: ['Table_ID', 'Table_Name', 'Area', 'Seats', 'Shape', 'Pos_X', 'Pos_Y', 'Width', 'Height', 'Active', 'Updated_At'],
    text: ['Table_ID', 'Table_Name', 'Area', 'Shape', 'Updated_At'],
    lists: { Shape: TABLE_SHAPES, Active: ['TRUE', 'FALSE'] }
  },
  Open_Orders: {
    headers: ['Order_ID', 'Table_ID', 'Table_Name', 'Pax', 'Status', 'Items_JSON', 'Subtotal', 'Opened_At', 'Opened_Ms',
              'Opened_By', 'Updated_At', 'Updated_By', 'Version', 'Transaction_ID', 'Closed_At',
              'Guest_Name', 'Paid_Transactions', 'Merged_Into'],
    text: ['Order_ID', 'Table_ID', 'Table_Name', 'Status', 'Items_JSON', 'Opened_At', 'Opened_By', 'Updated_At',
           'Updated_By', 'Transaction_ID', 'Closed_At', 'Guest_Name', 'Paid_Transactions', 'Merged_Into'],
    money: ['Subtotal']
  },
  Transactions: {
    headers: ['Transaction_ID', 'Date', 'Time', 'Cashier', 'Subtotal', 'Discount', 'Grand_Total', 'Payment_Method',
              'Amount_Paid', 'Change', 'Status', 'Cashier_ID', 'Timestamp', 'Client_Ref', 'Outlet_ID', 'Notes',
              'Order_Type', 'Table_Name', 'Pax', 'Service_Charge', 'Tax', 'Order_ID',
              'Item_Discount', 'Bill_Discount', 'Bill_Discount_Info', 'Rounding', 'Void_Reason', 'Void_By', 'Void_At',
              'Guest_Name', 'Shift_ID', 'Split_Info', 'Duration_Min'],
    text: ['Transaction_ID', 'Date', 'Time', 'Cashier', 'Payment_Method', 'Status', 'Cashier_ID', 'Timestamp',
           'Client_Ref', 'Outlet_ID', 'Notes', 'Order_Type', 'Table_Name', 'Order_ID', 'Bill_Discount_Info',
           'Void_Reason', 'Void_By', 'Void_At', 'Guest_Name', 'Shift_ID', 'Split_Info'],
    money: ['Subtotal', 'Discount', 'Grand_Total', 'Amount_Paid', 'Change', 'Service_Charge', 'Tax', 'Item_Discount',
            'Bill_Discount', 'Rounding']
  },
  Transaction_Details: {
    headers: ['Transaction_ID', 'Line_No', 'Product_ID', 'Product_Name', 'Category', 'Quantity', 'Unit_Price', 'Total',
              'Unit_Cost', 'Date', 'Discount', 'Discount_Info', 'Net_Total', 'Note', 'Modifier_Of'],
    text: ['Transaction_ID', 'Product_ID', 'Product_Name', 'Category', 'Date', 'Discount_Info', 'Note'],
    money: ['Unit_Price', 'Total', 'Unit_Cost', 'Discount', 'Net_Total']
  },
  // One row per payment. A normal bill has 1 row; a bill split equally ("bagi rata") has one row per person.
  Payments: {
    headers: ['Payment_ID', 'Transaction_ID', 'Seq', 'Date', 'Method', 'Amount', 'Rounding', 'Paid', 'Change', 'Shift_ID',
              'Status', 'Timestamp'],
    text: ['Payment_ID', 'Transaction_ID', 'Date', 'Method', 'Shift_ID', 'Status', 'Timestamp'],
    money: ['Amount', 'Rounding', 'Paid', 'Change']
  },
  // Cash drawer shifts: opening count, closing (blind) count, difference.
  Shifts: {
    headers: ['Shift_ID', 'Date', 'Status', 'Opened_At', 'Opened_By', 'Opened_By_ID', 'Opening_Cash', 'Opening_Count',
              'Previous_Left', 'Opening_Diff', 'Closed_At', 'Closed_By', 'Closed_By_ID', 'Cash_Sales', 'Cash_In', 'Cash_Out',
              'Setor_Total', 'Expected_Cash', 'Counted_Cash', 'Difference', 'Closing_Count', 'Left_For_Next', 'Final_Setor',
              'Non_Cash', 'Tx_Count', 'Notes', 'Outlet_ID'],
    text: ['Shift_ID', 'Date', 'Status', 'Opened_At', 'Opened_By', 'Opened_By_ID', 'Opening_Count', 'Closed_At', 'Closed_By',
           'Closed_By_ID', 'Closing_Count', 'Non_Cash', 'Notes', 'Outlet_ID'],
    money: ['Opening_Cash', 'Previous_Left', 'Opening_Diff', 'Cash_Sales', 'Cash_In', 'Cash_Out', 'Setor_Total', 'Expected_Cash',
            'Counted_Cash', 'Difference', 'Left_For_Next', 'Final_Setor']
  },
  // Cash in / out of the drawer during a shift, and handing cash over (setor) to the owner / admin.
  Cash_Movements: {
    headers: ['Movement_ID', 'Shift_ID', 'Timestamp', 'Date', 'Type', 'Amount', 'Reason', 'User_ID', 'User_Name', 'Status',
              'Confirmed_By', 'Confirmed_At', 'Confirm_Note', 'Count'],
    text: ['Movement_ID', 'Shift_ID', 'Timestamp', 'Date', 'Type', 'Reason', 'User_ID', 'User_Name', 'Status', 'Confirmed_By',
           'Confirmed_At', 'Confirm_Note', 'Count'],
    money: ['Amount'],
    lists: { Type: CASH_MOVE_TYPES }
  },
  // Orders sent to the kitchen / bar screens. One ticket per "round" of a table, per takeaway order, and per void.
  Kitchen_Tickets: {
    headers: ['Ticket_ID', 'Date', 'Created_At', 'Created_Ms', 'Created_By', 'Order_ID', 'Table_Name', 'Guest_Name', 'Round',
              'Kind', 'Items_JSON', 'Food_Status', 'Food_Done_At', 'Bar_Status', 'Bar_Done_At'],
    text: ['Ticket_ID', 'Date', 'Created_At', 'Created_By', 'Order_ID', 'Table_Name', 'Guest_Name', 'Kind', 'Items_JSON',
           'Food_Status', 'Food_Done_At', 'Bar_Status', 'Bar_Done_At']
  },
  Notifications: {
    headers: ['Notification_ID', 'Timestamp', 'Type', 'Title', 'Message', 'Reference_ID', 'Table_Name', 'Amount', 'Reason',
              'User_ID', 'User_Name', 'Role', 'Read_At', 'Read_By'],
    text: ['Notification_ID', 'Timestamp', 'Type', 'Title', 'Message', 'Reference_ID', 'Table_Name', 'Reason', 'User_ID',
           'User_Name', 'Role', 'Read_At', 'Read_By'],
    money: ['Amount']
  },
  Audit_Log: {
    headers: ['Timestamp', 'User_ID', 'Username', 'Action', 'Record_Type', 'Record_ID', 'Details'],
    text: ['Timestamp', 'User_ID', 'Username', 'Action', 'Record_Type', 'Record_ID', 'Details']
  },

  // ---- Phase 2-3: recipes, purchasing, stock ----
  Ingredients: {
    headers: ['Ingredient_ID', 'Ingredient_Name', 'Ingredient_Group', 'Base_Unit', 'Purchase_Unit', 'Purchase_To_Base',
              'Cost_Per_Base_Unit', 'Last_Purchase_Price', 'Stock_Qty_Base', 'Min_Stock_Base', 'Default_Supplier_ID',
              'Active_Status', 'Updated_At'],
    text: ['Ingredient_ID', 'Ingredient_Name', 'Ingredient_Group', 'Base_Unit', 'Purchase_Unit', 'Default_Supplier_ID', 'Updated_At'],
    money: ['Last_Purchase_Price'],
    lists: { Ingredient_Group: INGREDIENT_GROUPS, Base_Unit: BASE_UNITS, Active_Status: ['TRUE', 'FALSE'] }
  },
  Recipes: {
    headers: ['Recipe_ID', 'Product_ID', 'Recipe_Name', 'Recipe_Group', 'Yield_Quantity', 'Yield_Unit', 'Active_Status',
              'Updated_At', 'Updated_By', 'Notes'],
    text: ['Recipe_ID', 'Product_ID', 'Recipe_Name', 'Recipe_Group', 'Yield_Unit', 'Updated_At', 'Updated_By', 'Notes']
  },
  Recipe_Details: {
    headers: ['Recipe_ID', 'Ingredient_ID', 'Quantity_Required', 'Unit', 'Cost_Per_Unit', 'Ingredient_Cost', 'Line_No'],
    text: ['Recipe_ID', 'Ingredient_ID', 'Unit']
  },
  Suppliers: {
    headers: ['Supplier_ID', 'Supplier_Name', 'Contact_Person', 'Phone', 'Address', 'Notes', 'Active_Status', 'Updated_At'],
    text: ['Supplier_ID', 'Supplier_Name', 'Contact_Person', 'Phone', 'Address', 'Notes', 'Updated_At'],
    lists: { Active_Status: ['TRUE', 'FALSE'] }
  },
  Purchase_Orders: {
    headers: ['PO_ID', 'PO_Date', 'Supplier_ID', 'Status', 'Total', 'Created_By', 'Received_Date', 'Received_By', 'Notes',
              'Type', 'Invoice_No', 'Received_Total', 'Updated_At'],
    text: ['PO_ID', 'PO_Date', 'Supplier_ID', 'Status', 'Created_By', 'Received_Date', 'Received_By', 'Notes', 'Type',
           'Invoice_No', 'Updated_At'],
    money: ['Total', 'Received_Total']
  },
  Purchase_Order_Details: {
    headers: ['PO_ID', 'Line_No', 'Ingredient_ID', 'Quantity', 'Unit', 'Unit_Price', 'Line_Total', 'Qty_Received',
              'Received_Unit_Price', 'Received_Total', 'Unit_To_Base'],
    text: ['PO_ID', 'Ingredient_ID', 'Unit'],
    money: ['Unit_Price', 'Line_Total', 'Received_Unit_Price', 'Received_Total']
  },
  Inventory_Movements: {
    headers: ['Movement_ID', 'Timestamp', 'Ingredient_ID', 'Movement_Type', 'Quantity', 'Unit', 'Quantity_Base',
              'Unit_Cost_Base', 'Total_Cost', 'Reference_ID', 'User_ID', 'Notes', 'Date', 'Ingredient_Name', 'Supplier_ID'],
    text: ['Movement_ID', 'Timestamp', 'Ingredient_ID', 'Movement_Type', 'Unit', 'Reference_ID', 'User_ID', 'Notes', 'Date',
           'Ingredient_Name', 'Supplier_ID'],
    money: ['Total_Cost']
  }
};
