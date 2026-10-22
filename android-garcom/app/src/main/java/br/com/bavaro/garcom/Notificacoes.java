package br.com.bavaro.garcom;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.util.Map;

final class Notificacoes {
    static final String CANAL = "recados";
    static final String CANAL_URGENTE = "recados_urgentes";
    private static final long[] VIBRA = {0, 400, 150, 400};
    private static final long[] VIBRA_URG = {0, 700, 200, 700, 200, 700, 200, 700};

    private Notificacoes() { }

    private static Uri som(Context c, int res) {
        return Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + c.getPackageName() + "/" + res);
    }

    static void criarCanais(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        AudioAttributes aa = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();

        NotificationChannel n = new NotificationChannel(CANAL, "Recados do gerente", NotificationManager.IMPORTANCE_HIGH);
        n.setDescription("Recados que o gerente manda pelo app");
        n.setSound(som(c, R.raw.recado), aa);
        n.enableVibration(true); n.setVibrationPattern(VIBRA);
        n.enableLights(true); n.setLightColor(Color.YELLOW);
        n.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(n);

        NotificationChannel u = new NotificationChannel(CANAL_URGENTE, "Recados URGENTES", NotificationManager.IMPORTANCE_HIGH);
        u.setDescription("Toca até o garçom abrir");
        u.setSound(som(c, R.raw.recado_urgente), aa);
        u.enableVibration(true); u.setVibrationPattern(VIBRA_URG);
        u.enableLights(true); u.setLightColor(Color.RED);
        u.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(u);
    }

    static void mostrarRecado(Context c, Map<String, String> d) {
        criarCanais(c);
        String id = d.get("id") == null ? String.valueOf(System.currentTimeMillis()) : d.get("id");
        boolean urg = "1".equals(d.get("urgente"));
        int nid = id.hashCode();
        String titulo = d.get("titulo") == null ? "📣 Recado do gerente" : d.get("titulo");
        String texto = d.get("texto") == null ? "" : d.get("texto");
        String url = d.get("url") == null ? c.getString(R.string.url_inicial) : d.get("url");

        int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent abrir = new Intent(c, Inicio.class).setData(Uri.parse(url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent piAbrir = PendingIntent.getActivity(c, nid, abrir, fl);

        NotificationCompat.Builder nb = new NotificationCompat.Builder(c, urg ? CANAL_URGENTE : CANAL)
                .setSmallIcon(R.drawable.ic_recado)
                .setColor(Color.parseColor("#D4A843"))
                .setContentTitle(titulo)
                .setContentText(texto)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(texto))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(urg ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setSound(som(c, urg ? R.raw.recado_urgente : R.raw.recado))
                .setVibrate(urg ? VIBRA_URG : VIBRA)
                .setAutoCancel(true)
                .setContentIntent(piAbrir)
                .addAction(0, "✓ Vi", resposta(c, id, "visto", nid))
                .addAction(0, "🏃 Já vou", resposta(c, id, "ja_vou", nid));

        Notification n = nb.build();
        if (urg) n.flags |= Notification.FLAG_INSISTENT;   // repete o som até abrir/responder
        try {
            NotificationManagerCompat.from(c).notify(nid, n);
        } catch (SecurityException semPermissao) { /* notificações desligadas no aparelho */ }
    }

    private static PendingIntent resposta(Context c, String id, String resp, int nid) {
        Intent i = new Intent(c, RespostaReceiver.class)
                .putExtra("id", id).putExtra("resposta", resp).putExtra("nid", nid);
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getBroadcast(c, (id + resp).hashCode(), i, fl);
    }
}
