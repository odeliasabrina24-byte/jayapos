/**
 * Cashbook.gs — Jurnal kas harian (uang masuk & keluar).
 *  - Akun tetap: Kas Laci, BCA, BRI.
 *  - Kategori bisa ditambah dan dinonaktifkan sendiri lewat app (tidak perlu edit Sheet).
 *  - Admin & Purchasing bisa mencatat dan mengubah transaksi; Owner hanya melihat.
 */

const KAS_ACCOUNTS = [
  { code: 'KAS_LACI', label: 'Kas Laci' },
  { code: 'BCA', label: 'BCA' },
  { code: 'BRI', label: 'BRI' }
];

const KAS_DEFAULT_CATEGORIES = ['Penjualan', 'Bahan Baku', 'Gaji', 'Sewa', 'Listrik', 'Air', 'Gas',
  'Transportasi', 'Perlengkapan', 'Perbaikan', 'Setoran Modal', 'Tarik Tunai', 'Lainnya'];

function kasAccountLabel_(code) {
  const a = KAS_ACCOUNTS.filter(function (x) { return x.code === code; })[0];
  return a ? a.label : code;
}

/** Kategori. Kalau belum ada sama sekali, isi daftar awal (sekali saja). */
function kasCategories_() {
  let rows = readTable_('Kas_Kategori').rows;
  if (!rows.length) {
    withLock_(function () {
      if (!readTable_('Kas_Kategori').rows.length) {
        const now = nowStamp_();
        appendObjects_('Kas_Kategori', KAS_DEFAULT_CATEGORIES.map(function (name, i) {
          return { Category_ID: 'KK' + String(i + 1).padStart(3, '0'), Category_Name: name, Active_Status: true, Created_At: now };
        }));
      }
    });
    rows = readTable_('Kas_Kategori').rows;
  }
  return rows.map(function (r) {
    return { id: String(r.Category_ID), name: String(r.Category_Name).trim(), active: r.Active_Status === true || String(r.Active_Status).toUpperCase() === 'TRUE' };
  });
}

function apiGetCashbook(token, d) {
  return run_(function () {
    const user = requirePerm_(token, ['cashbook.manage', 'cashbook.view']);
    d = d || {};
    const month = /^\d{4}-\d{2}$/.test(String(d.month || '')) ? String(d.month) : fmt_(new Date(), 'yyyy-MM');
    const entries = readTable_('Jurnal_Kas').rows.map(function (r) {
      return {
        id: String(r.Entry_ID), date: dateText_(r.Entry_Date), desc: String(r.Description || ''), category: String(r.Category || ''),
        account: String(r.Account || ''), accountLabel: kasAccountLabel_(String(r.Account || '')),
        in: moneyNum_(r.Money_In) || 0, out: moneyNum_(r.Money_Out) || 0, proof: String(r.Proof_No || ''),
        by: String(r.Entered_By || '')
      };
    }).filter(function (e) { return e.date.slice(0, 7) === month; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1); });

    const perAcc = KAS_ACCOUNTS.map(function (a) {
      const mine = entries.filter(function (e) { return e.account === a.code; });
      const i = mine.reduce(function (s, e) { return s + e.in; }, 0);
      const o = mine.reduce(function (s, e) { return s + e.out; }, 0);
      return { code: a.code, label: a.label, in: Math.round(i * 100) / 100, out: Math.round(o * 100) / 100, net: Math.round((i - o) * 100) / 100, count: mine.length };
    });
    const totIn = Math.round(entries.reduce(function (s, e) { return s + e.in; }, 0) * 100) / 100;
    const totOut = Math.round(entries.reduce(function (s, e) { return s + e.out; }, 0) * 100) / 100;

    return {
      canEdit: hasPerm_(user, 'cashbook.manage'),
      month: month,
      accounts: KAS_ACCOUNTS,
      categories: kasCategories_(),
      entries: entries,
      perAccount: perAcc,
      totals: { in: totIn, out: totOut, net: Math.round((totIn - totOut) * 100) / 100 }
    };
  });
}

function apiSaveCashEntry(token, d) {
  return run_(function () {
    const user = requirePerm_(token, 'cashbook.manage');
    d = d || {};
    const date = String(d.date || '').trim();
    const desc = cleanText_(d.desc, 150);
    const category = cleanText_(d.category, 40);
    const account = String(d.account || '').trim();
    const money_in = Number(d.in || 0);
    const money_out = Number(d.out || 0);
    const proof = cleanText_(d.proof, 60);
    if (!isDateStr_(date)) throw new Error('Tanggal harus yyyy-mm-dd.');
    if (!desc) throw new Error('Isi keterangan transaksi.');
    if (!category) throw new Error('Pilih kategori.');
    if (!KAS_ACCOUNTS.some(function (a) { return a.code === account; })) throw new Error('Pilih akun: Kas Laci, BCA, atau BRI.');
    if (!(money_in >= 0) || !(money_out >= 0) || money_in > 1000000000 || money_out > 1000000000) throw new Error('Nominal harus angka 0 atau lebih.');
    if ((money_in > 0) === (money_out > 0)) throw new Error('Isi salah satu saja: Masuk atau Keluar (yang satunya 0).');
    const cats = kasCategories_();
    return withLock_(function () {
      const id = String(d.id || '');
      const cat = cats.filter(function (c) { return c.name.toLowerCase() === category.toLowerCase(); })[0];
      if (!cat) throw new Error('Kategori "' + category + '" belum ada. Tambah dulu lewat "Kelola kategori".');
      if (!cat.active && !(id && readTable_('Jurnal_Kas').rows.some(function (r) { return String(r.Entry_ID) === id && String(r.Category).toLowerCase() === category.toLowerCase(); }))) {
        throw new Error('Kategori "' + cat.name + '" sudah dinonaktifkan. Aktifkan lagi lewat "Kelola kategori".');
      }
      const fields = { Entry_Date: date, Description: desc, Category: cat.name, Account: account,
        Money_In: money_in, Money_Out: money_out, Proof_No: proof, Updated_At: nowStamp_() };
      if (id) {
        const old = readTable_('Jurnal_Kas').rows.filter(function (r) { return String(r.Entry_ID) === id; })[0];
        if (!old) throw new Error('Transaksi tidak ditemukan.');
        updateRow_('Jurnal_Kas', old._row, fields);
        audit_(user, 'KAS_UPDATE', 'Jurnal_Kas', id, { date: date, category: cat.name, account: account, in: money_in, out: money_out });
        return { ok: true, id: id };
      }
      const newId = nextId_(readTable_('Jurnal_Kas').rows.map(function (r) { return String(r.Entry_ID); }), 'JK', 4);
      fields.Entry_ID = newId;
      fields.Entered_By = user.name;
      fields.Entered_At = nowStamp_();
      appendObjects_('Jurnal_Kas', [fields]);
      audit_(user, 'KAS_CREATE', 'Jurnal_Kas', newId, { date: date, category: cat.name, account: account, in: money_in, out: money_out });
      return { ok: true, id: newId };
    });
  });
}

/** Tambah kategori baru, atau aktifkan / nonaktifkan yang sudah ada. */
function apiSaveKasCategory(token, d) {
  return run_(function () {
    const user = requirePerm_(token, 'cashbook.manage');
    d = d || {};
    const list = kasCategories_();
    return withLock_(function () {
      const id = String(d.id || '');
      if (id) {
        const old = list.filter(function (c) { return c.id === id; })[0];
        if (!old) throw new Error('Kategori tidak ditemukan.');
        const row = readTable_('Kas_Kategori').rows.filter(function (r) { return String(r.Category_ID) === id; })[0];
        updateRow_('Kas_Kategori', row._row, { Active_Status: d.active !== false });
        audit_(user, d.active !== false ? 'KAS_CAT_ON' : 'KAS_CAT_OFF', 'Kas_Kategori', id, { name: old.name });
        return { ok: true };
      }
      const name = cleanText_(d.name, 40);
      if (!name) throw new Error('Isi nama kategori.');
      if (list.some(function (c) { return c.name.toLowerCase() === name.toLowerCase(); })) throw new Error('Kategori "' + name + '" sudah ada.');
      const newId = nextId_(list.map(function (c) { return c.id; }), 'KK', 3);
      appendObjects_('Kas_Kategori', [{ Category_ID: newId, Category_Name: name, Active_Status: true, Created_At: nowStamp_() }]);
      audit_(user, 'KAS_CAT_ADD', 'Kas_Kategori', newId, { name: name });
      return { ok: true, id: newId };
    });
  });
}
