package br.com.bavaro.garcom;

import android.app.Application;

import com.google.firebase.messaging.FirebaseMessaging;

public class GarcomApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Notificacoes.criarCanais(this);
        // já deixa o token guardado pro próximo "abrir"
        try {
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(t -> Prefs.salvarToken(this, t));
        } catch (Exception ignored) { }
    }
}
