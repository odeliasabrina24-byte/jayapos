/**
 * Notif ke HP lewat ntfy.sh (gratis). Topik diisi di Pengaturan > Topik notif HP.
 * Kalau topik kosong, tidak ada yang dikirim. Gagal kirim tidak boleh menghentikan transaksi.
 */
function notifyPush_(title, body, priority) {
  try {
    const topic = String(getSettingsMap_().Notif_Topic || '').trim();
    if (!topic) return;
    const res = UrlFetchApp.fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
      method: 'post',
      payload: String(body || ''),
      contentType: 'text/plain; charset=utf-8',
      headers: { Title: String(title || 'JayaPOS'), Priority: priority || 'high' },
      muteHttpExceptions: true
    });
    // ntfy membalas error (mis. 429/403) tanpa melempar exception, jadi dicatat di sini.
    const code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      console.error('notifyPush_ ntfy ' + code + ': ' + res.getContentText());
    } else {
      console.log('notifyPush_ terkirim ke topik ' + topic + ' (' + code + ')');
    }
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
