package com.santiromero.mibiblioteca;

import android.content.ContentResolver;
import android.content.UriPermission;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Entrega al lector los archivos de las carpetas que eligió el usuario, leyéndolos en el lugar.
 * La web pide  https://localhost/_book/<uri del documento codificada>  y acá se responde con el
 * contenido del archivo. Solo se sirven documentos que estén dentro de una carpeta con permiso.
 */
public class BookWebViewClient extends BridgeWebViewClient {
    private static final String PREFIX = "/_book/";
    private final Bridge bridge;

    public BookWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath();
        if (path != null && path.startsWith(PREFIX) && "localhost".equals(url.getHost())) {
            return serveBook(path.substring(PREFIX.length()));
        }
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse serveBook(String encoded) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        try {
            Uri doc = Uri.parse(Uri.decode(encoded));
            ContentResolver resolver = bridge.getContext().getContentResolver();
            if (!isAllowed(resolver, doc)) {
                return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", headers, null);
            }
            ParcelFileDescriptor pfd = resolver.openFileDescriptor(doc, "r");
            if (pfd == null) {
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
            }
            long size = pfd.getStatSize();
            InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
            if (size >= 0) headers.put("Content-Length", String.valueOf(size));
            String name = doc.getLastPathSegment() == null ? "" : doc.getLastPathSegment().toLowerCase();
            String mime = name.endsWith(".pdf") ? "application/pdf"
                : name.endsWith(".epub") ? "application/epub+zip"
                : "application/octet-stream";
            return new WebResourceResponse(mime, null, 200, "OK", headers, in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
    }

    static boolean isAllowed(ContentResolver resolver, Uri doc) {
        String target = doc.toString();
        for (UriPermission p : resolver.getPersistedUriPermissions()) {
            if (!p.isReadPermission()) continue;
            String tree = p.getUri().toString();
            if (target.startsWith(tree + "/document/")) return true;
        }
        return false;
    }
}
