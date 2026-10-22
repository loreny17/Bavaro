package br.com.bavaro.garcom;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.browser.customtabs.CustomTabColorSchemeParams;
import androidx.browser.trusted.ScreenOrientation;
import androidx.browser.trusted.TrustedWebActivityIntentBuilder;
import androidx.core.content.ContextCompat;

import com.google.androidbrowserhelper.trusted.TwaLauncher;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Abre o app do garçom (o mesmo site de sempre) no Chrome, em tela cheia, levando junto
 * o "endereço" de notificação deste celular (?app=android&fcm=...). O site guarda e liga
 * esse endereço ao garçom logado — é assim que o recado do gerente chega neste aparelho.
 */
public class Inicio extends AppCompatActivity {
    private static final int PEDIDO_NOTIF = 7;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TwaLauncher launcher;
    private boolean abriu = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !Prefs.jaPediuPermissao(this)) {
            Prefs.marcarPediuPermissao(this);
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PEDIDO_NOTIF);
            return;
        }
        continuar();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PEDIDO_NOTIF) continuar();
    }

    private void continuar() {
        handler.postDelayed(() -> abrir(Prefs.token(this)), 3500);
        try {
            FirebaseMessaging.getInstance().getToken()
                    .addOnSuccessListener(t -> { Prefs.salvarToken(this, t); abrir(t); })
                    .addOnFailureListener(e -> abrir(Prefs.token(this)));
        } catch (Exception e) {
            abrir(Prefs.token(this));
        }
    }

    private void abrir(String token) {
        if (abriu || isFinishing()) return;
        abriu = true;
        handler.removeCallbacksAndMessages(null);
        Uri base = getIntent() != null && getIntent().getData() != null
                ? getIntent().getData() : Uri.parse(getString(R.string.url_inicial));
        Uri.Builder b = base.buildUpon().appendQueryParameter("app", "android");
        if (token != null && !token.isEmpty()) b.appendQueryParameter("fcm", token);
        int cor = Color.parseColor("#0A0A0A");
        TrustedWebActivityIntentBuilder twa = new TrustedWebActivityIntentBuilder(b.build())
                .setDefaultColorSchemeParams(new CustomTabColorSchemeParams.Builder()
                        .setToolbarColor(cor).setNavigationBarColor(cor).build())
                .setScreenOrientation(ScreenOrientation.PORTRAIT);
        launcher = new TwaLauncher(this);
        launcher.launch(twa, null, null, this::finish, TwaLauncher.CCT_FALLBACK_STRATEGY);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        handler.removeCallbacksAndMessages(null);
        if (launcher != null) launcher.destroy();
    }
}
