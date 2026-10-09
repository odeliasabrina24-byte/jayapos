/**
 * Notif ke HP lewat ntfy.sh (gratis). Topik diisi di Pengaturan > Topik notif HP.
 * Kalau topik kosong, tidak ada yang dikirim. Gagal kirim tidak boleh menghentikan transaksi.
 */
function notifyPush_(title, body, priority) {
  try {
    const topic = String(getSettingsMap_().Notif_Topic || '').trim();
    if (!topic) return;
    UrlFetchApp.fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
      method: 'post',
      payload: String(body || ''),
      contentType: 'text/plain; charset=utf-8',
      headers: { Title: String(title || 'JayaPOS'), Priority: priority || 'high' },
      muteHttpExceptions: true
    });
  } catch (e) {
    console.error('notifyPush_ gagal: ' + e);
  }
}

/** Satu notif per kejadian: meja, pesanan ke-berapa, lalu tiap item (dapur/bar). */
function notifyTicketLines_(title, tableName, round, lines) {
  if (!lines || !lines.length) return;
  const head = String(tableName || '-') + ' · pesanan ' + (Number(round) || 0);
  const body = lines.map(function (l) {
    return l.qty + '× ' + l.name + ' (' + (l.st === 'FOOD' ? 'Dapur' : 'Bar') + ')';
  }).join('\n');
  notifyPush_(title, head + '\n' + body);
}
