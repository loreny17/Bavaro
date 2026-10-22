package br.com.bavaro.garcom;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/** Recebe o recado do gerente (mesmo com o app fechado) e mostra a notificação. */
public class RecadoService extends FirebaseMessagingService {
    @Override
    public void onNewToken(@NonNull String token) {
        Prefs.salvarToken(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        if (d == null || !"recado".equals(d.get("tipo"))) return;
        Notificacoes.mostrarRecado(this, d);
    }
}
