package com.babikopijaya.jayaprint;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Layar pengaturan: IP printer, port, jumlah salinan, dan tombol tes cetak. */
public class MainActivity extends Activity {

    private EditText ipField;
    private EditText portField;
    private EditText copiesField;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);

        root.addView(label("Printer struk (Epson TM-T82X lewat WiFi/LAN)", 17, true));
        root.addView(spacer(12));

        root.addView(label("IP printer", 14, false));
        ipField = field(Printer.ip(this), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        root.addView(ipField);

        root.addView(label("Port (biasanya 9100)", 14, false));
        portField = field(String.valueOf(Printer.port(this)), InputType.TYPE_CLASS_NUMBER);
        root.addView(portField);

        root.addView(label("Jumlah salinan per cetak", 14, false));
        copiesField = field(String.valueOf(Printer.copies(this)), InputType.TYPE_CLASS_NUMBER);
        root.addView(copiesField);

        root.addView(spacer(12));
        Button save = new Button(this);
        save.setText("Simpan");
        save.setOnClickListener(v -> save(true));
        root.addView(save, matchWidth());

        Button test = new Button(this);
        test.setText("Tes cetak");
        test.setOnClickListener(v -> testPrint());
        root.addView(test, matchWidth());

        root.addView(spacer(8));
        status = label("", 15, true);
        root.addView(status);

        root.addView(spacer(16));
        root.addView(label(
                "Cara pakai\n"
                + "1. Isi IP printer lalu tekan Simpan.\n"
                + "2. Tekan Tes cetak. Kalau keluar kertas, sudah siap.\n"
                + "3. Di JayaPOS, buka struk lalu tekan \"Cetak (JayaPrint)\". "
                + "Struk langsung tercetak dan layar kembali ke JayaPOS.\n\n"
                + "HP/tablet harus tersambung ke WiFi yang sama dengan printer. "
                + "IP printer bisa dilihat dengan mematikan printer, lalu menyalakannya "
                + "sambil menahan tombol Feed: printer mencetak lembar status berisi IP.\n\n"
                + "Bisa juga mencetak teks dari aplikasi lain lewat menu Bagikan → JayaPrint.",
                14, false));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        setContentView(scroll);
    }

    private boolean save(boolean showMessage) {
        String ip = ipField.getText().toString().trim();
        int port;
        int copies;
        try {
            port = Integer.parseInt(portField.getText().toString().trim());
            copies = Integer.parseInt(copiesField.getText().toString().trim());
        } catch (NumberFormatException e) {
            setStatus("Port dan jumlah salinan harus angka.", false);
            return false;
        }
        if (!ip.matches("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")) {
            setStatus("Format IP salah. Contoh: 192.168.100.7", false);
            return false;
        }
        if (copies < 1 || copies > 5) {
            setStatus("Jumlah salinan 1 sampai 5.", false);
            return false;
        }
        Printer.prefs(this).edit()
                .putString("ip", ip)
                .putInt("port", port)
                .putInt("copies", copies)
                .apply();
        if (showMessage) setStatus("Tersimpan.", true);
        return true;
    }

    private void testPrint() {
        if (!save(false)) return;
        final String ip = Printer.ip(this);
        final int port = Printer.port(this);
        setStatus("Mengirim tes cetak ke " + ip + "...", true);
        Printer.QUEUE.execute(() -> {
            String err = Printer.send(ip, port, Printer.testPage(ip, port), 1);
            runOnUiThread(() -> {
                if (err == null) setStatus("Tes cetak terkirim. Cek kertas di printer.", true);
                else setStatus(err, false);
            });
        });
    }

    private void setStatus(String msg, boolean ok) {
        status.setText(msg);
        status.setTextColor(ok ? Color.rgb(27, 120, 60) : Color.rgb(180, 30, 30));
    }

    // ---------- tampilan ----------

    private TextView label(String text, int sp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(Color.rgb(30, 30, 30));
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(6), 0, dp(2));
        return t;
    }

    private EditText field(String value, int type) {
        EditText e = new EditText(this);
        e.setText(value);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setGravity(Gravity.CENTER_VERTICAL);
        return e;
    }

    private View spacer(int h) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(h)));
        return v;
    }

    private LinearLayout.LayoutParams matchWidth() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
