package br.com.bavaro.garcom;

import android.content.Context;
import android.content.SharedPreferences;

final class Prefs {
    private Prefs() { }
    private static SharedPreferences p(Context c) { return c.getSharedPreferences("garcom", Context.MODE_PRIVATE); }
    static void salvarToken(Context c, String t) { if (t != null && !t.isEmpty()) p(c).edit().putString("fcm", t).apply(); }
    static String token(Context c) { return p(c).getString("fcm", ""); }
    static boolean jaPediuPermissao(Context c) { return p(c).getBoolean("pediu_notif", false); }
    static void marcarPediuPermissao(Context c) { p(c).edit().putBoolean("pediu_notif", true).apply(); }
}
