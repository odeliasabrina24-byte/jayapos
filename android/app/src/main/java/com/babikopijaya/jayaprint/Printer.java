package com.babikopijaya.jayaprint;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.text.Normalizer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Kirim data cetak (perintah ESC/POS) langsung ke printer jaringan lewat port 9100
 * ("RAW" / "Port 9100"). Semua printer kasir Epson ber-LAN mendukung ini.
 */
public final class Printer {

    public static final String DEFAULT_IP = "192.168.100.7";
    public static final int DEFAULT_PORT = 9100;

    /** Satu antrean: kalau dua struk dikirim berdekatan, dicetak bergantian, tidak bertabrakan. */
    public static final ExecutorService QUEUE = Executors.newSingleThreadExecutor();

    private Printer() {}

    // ---------- Pengaturan ----------

    public static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("jayaprint", Context.MODE_PRIVATE);
    }

    public static String ip(Context c) {
        return prefs(c).getString("ip", DEFAULT_IP);
    }

    public static int port(Context c) {
        return prefs(c).getInt("port", DEFAULT_PORT);
    }

    public static int copies(Context c) {
        return Math.max(1, prefs(c).getInt("copies", 1));
    }

    // ---------- Kirim ke printer ----------

    /**
     * Kirim data ke printer. Mengembalikan null kalau berhasil, atau pesan error
     * (Bahasa Indonesia) kalau gagal. Jangan dipanggil dari thread utama.
     */
    public static String send(String ip, int port, byte[] data, int copies) {
        if (ip == null || ip.trim().isEmpty()) return "IP printer belum diisi. Buka aplikasi JayaPrint.";
        if (data == null || data.length == 0) return "Tidak ada isi yang dicetak.";
        copies = Math.max(1, Math.min(copies, 5));
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(ip.trim(), port), 5000);
            s.setSoTimeout(5000);
            OutputStream out = s.getOutputStream();
            for (int i = 0; i < copies; i++) {
                out.write(data);
            }
            out.flush();
            // Tunggu sebentar supaya printer selesai menerima sebelum koneksi ditutup.
            waitForPrinter(s);
            return null;
        } catch (java.net.SocketTimeoutException e) {
            return "Printer tidak menjawab di " + ip + ". Cek printer menyala dan HP di WiFi yang sama.";
        } catch (java.net.ConnectException e) {
            return "Tidak bisa terhubung ke printer " + ip + ":" + port + ". Cek IP dan kabel LAN printer.";
        } catch (java.net.NoRouteToHostException e) {
            return "Printer " + ip + " tidak ditemukan. Pastikan HP tersambung ke WiFi toko.";
        } catch (Exception e) {
            return "Gagal mencetak: " + e.getMessage();
        } finally {
            try { s.close(); } catch (Exception ignored) {}
        }
    }

    /**
     * Minta status printer (DLE EOT 1) dan tunggu jawabannya. Printer menjawab setelah
     * memproses data sebelumnya, jadi koneksi tidak ditutup terlalu cepat.
     */
    private static void waitForPrinter(Socket s) {
        try {
            s.getOutputStream().write(new byte[]{0x10, 0x04, 0x01});
            s.getOutputStream().flush();
            s.setSoTimeout(1500);
            InputStream in = s.getInputStream();
            in.read();
        } catch (Exception ignored) {
            // Tidak semua mode printer menjawab; cukup beri jeda.
            try { Thread.sleep(300); } catch (InterruptedException ignored2) {}
        }
    }

    // ---------- Ubah teks biasa jadi perintah printer ----------

    /** Teks biasa (misalnya dari menu Bagikan) jadi data ESC/POS, lalu potong kertas. */
    public static byte[] textToEscPos(String text) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(0x1B); b.write(0x40);                 // ESC @  reset printer
        byte[] t = toPrinterText(text.replace("\r\n", "\n"));
        b.write(t, 0, t.length);
        if (!text.endsWith("\n")) b.write('\n');
        feedAndCut(b);
        return b.toByteArray();
    }

    /** Halaman tes: penggaris 48 kolom untuk memastikan lebar 80mm, tebal, huruf besar, potong. */
    public static byte[] testPage(String ip, int port) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(0x1B); b.write(0x40);                 // reset
        b.write(0x1B); b.write(0x61); b.write(1);     // rata tengah
        b.write(0x1B); b.write(0x45); b.write(1);     // tebal
        b.write(0x1D); b.write(0x21); b.write(0x11);  // huruf 2x
        put(b, "JayaPrint\n");
        b.write(0x1D); b.write(0x21); b.write(0x00);
        b.write(0x1B); b.write(0x45); b.write(0);
        put(b, "Tes cetak berhasil\n");
        put(b, "Printer " + ip + ":" + port + "\n\n");
        b.write(0x1B); b.write(0x61); b.write(0);     // rata kiri
        put(b, "Penggaris 48 kolom (kertas 80mm):\n");
        put(b, "123456789012345678901234567890123456789012345678\n");
        put(b, "------------------------------------------------\n");
        put(b, "Kopi Susu                              Rp 25.000\n");
        b.write(0x1B); b.write(0x45); b.write(1);
        b.write(0x1D); b.write(0x21); b.write(0x01);
        put(b, "TOTAL                                  Rp 25.000\n");
        b.write(0x1D); b.write(0x21); b.write(0x00);
        b.write(0x1B); b.write(0x45); b.write(0);
        put(b, "------------------------------------------------\n");
        put(b, "Kalau angka 48 muat dalam satu baris,\n");
        put(b, "lebar 80mm sudah benar.\n");
        feedAndCut(b);
        return b.toByteArray();
    }

    private static void feedAndCut(ByteArrayOutputStream b) {
        b.write(0x1D); b.write(0x56); b.write(0x42); b.write(0x03);  // GS V B n: maju lalu potong
    }

    private static void put(ByteArrayOutputStream b, String s) {
        byte[] t = toPrinterText(s);
        b.write(t, 0, t.length);
    }

    /** Huruf beraksen (é, ü) diganti huruf biasa; karakter lain di luar ASCII jadi '?'. */
    static byte[] toPrinterText(String s) {
        String n = Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}", "");
        byte[] out = new byte[n.length()];
        int k = 0;
        for (int i = 0; i < n.length(); i++) {
            char ch = n.charAt(i);
            if (ch == '\n' || (ch >= 32 && ch < 127)) out[k++] = (byte) ch;
            else if (ch == '\t') out[k++] = ' ';
            else if (ch == '\r') continue;
            else out[k++] = '?';
        }
        byte[] r = new byte[k];
        System.arraycopy(out, 0, r, 0, k);
        return r;
    }
}
