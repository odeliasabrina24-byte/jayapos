package com.babikopijaya.jayaprint;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.widget.Toast;

/**
 * Menerima perintah cetak lalu langsung kembali ke aplikasi sebelumnya (JayaPOS).
 *
 * Cara memanggil dari halaman web (Chrome):
 *   intent://print#Intent;scheme=jayaprint;package=com.babikopijaya.jayaprint;S.data=BASE64;end
 *     S.data   = perintah ESC/POS dalam base64 (dicetak apa adanya)
 *     S.text   = atau teks biasa (otomatis dipotong di akhir)
 *     S.copies = jumlah salinan (opsional, default dari pengaturan aplikasi)
 * Juga bisa dari menu "Bagikan" berisi teks di aplikasi lain.
 */
public class PrintActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final Context app = getApplicationContext();

        final byte[] data;
        int copies = Printer.copies(app);
        try {
            Intent in = getIntent();
            String action = in.getAction();
            if (Intent.ACTION_SEND.equals(action)) {
                CharSequence t = in.getCharSequenceExtra(Intent.EXTRA_TEXT);
                data = t == null ? null : Printer.textToEscPos(t.toString());
            } else {
                Uri uri = in.getData();
                String b64 = pick(in.getStringExtra("data"), uri, "data");
                String text = pick(in.getStringExtra("text"), uri, "text");
                String c = pick(in.getStringExtra("copies"), uri, "copies");
                if (c != null) {
                    try { copies = Integer.parseInt(c.trim()); } catch (NumberFormatException ignored) {}
                }
                if (b64 != null && !b64.isEmpty()) {
                    data = Base64.decode(b64.replace(' ', '+'), Base64.DEFAULT);
                } else if (text != null && !text.isEmpty()) {
                    data = Printer.textToEscPos(text);
                } else {
                    data = null;
                }
            }
        } catch (Exception e) {
            Toast.makeText(app, "Data cetak rusak: " + e.getMessage(), Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        if (data == null) {
            Toast.makeText(app, "Tidak ada isi yang dicetak.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        final String ip = Printer.ip(app);
        final int port = Printer.port(app);
        final int n = copies;
        Printer.QUEUE.execute(() -> {
            final String err = Printer.send(ip, port, data, n);
            runOnUiThread(() -> {
                if (err == null) {
                    Toast.makeText(app, "Struk terkirim ke printer", Toast.LENGTH_SHORT).show();
                } else {
                    Toast.makeText(app, err, Toast.LENGTH_LONG).show();
                }
                finish();
            });
        });
    }

    private static String pick(String extra, Uri uri, String key) {
        if (extra != null) return extra;
        if (uri != null && uri.isHierarchical()) return uri.getQueryParameter(key);
        return null;
    }
}
