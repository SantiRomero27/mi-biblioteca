package com.santiromero.mibiblioteca;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // El módulo propio se registra antes de crear el puente
        registerPlugin(LibraryPlugin.class);
        super.onCreate(savedInstanceState);
        // Sirve los libros de las carpetas elegidas en /_book/... sin copiarlos
        bridge.setWebViewClient(new BookWebViewClient(bridge));

        // Botón "atrás" de Android: vuelve dentro de la app (del libro a la biblioteca) y recién después sale
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = bridge.getWebView();
                if (web != null && web.canGoBack()) {
                    web.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }
}
