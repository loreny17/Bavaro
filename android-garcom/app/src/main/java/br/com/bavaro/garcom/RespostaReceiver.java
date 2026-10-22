package br.com.bavaro.garcom;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Botões "✓ Vi" / "🏃 Já vou" da notificação: avisa o gerente sem abrir o app. */
public class RespostaReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        final String id = i.getStringExtra("id");
        final String resp = i.getStringExtra("resposta");
        NotificationManagerCompat.from(c).cancel(i.getIntExtra("nid", 0));
        final PendingResult pr = goAsync();
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            HttpURLConnection con = null;
            try {
                JSONObject j = new JSONObject();
                j.put("acao", "resposta"); j.put("id", id); j.put("resposta", resp); j.put("token", Prefs.token(app));
                con = (HttpURLConnection) new URL(app.getString(R.string.site) + "/api/recado").openConnection();
                con.setRequestMethod("POST");
                con.setConnectTimeout(10000); con.setReadTimeout(10000);
                con.setDoOutput(true);
                con.setRequestProperty("Content-Type", "application/json");
                try (OutputStream os = con.getOutputStream()) { os.write(j.toString().getBytes(StandardCharsets.UTF_8)); }
                con.getResponseCode();
            } catch (Exception ignored) {
            } finally {
                if (con != null) con.disconnect();
                pr.finish();
            }
        }).start();
    }
}
