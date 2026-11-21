package com.santiromero.mibiblioteca;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.ActivityInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Módulo nativo de Mi biblioteca:
 *  - Carpetas: elegir, listar, quitar (permisos persistentes del sistema, sin pedir acceso a todo el almacenamiento)
 *  - Escaneo: busca PDF y EPUB y calcula la huella de cada archivo (mismo algoritmo que fingerprint() en books.js)
 *  - Borrar el archivo original
 *  - Ingreso con Google nativo (Credential Manager) → devuelve el idToken para Firebase
 */
@CapacitorPlugin(name = "Biblioteca")
public class LibraryPlugin extends Plugin {
    private static final int CHUNK = 2 * 1024 * 1024;
    private static final int MAX_DEPTH = 10;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // ---------- Carpetas ----------

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "onFolderPicked");
    }

    @ActivityCallback
    private void onFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("cancelled", "cancelled");
            return;
        }
        Uri tree = data.getData();
        ContentResolver resolver = getContext().getContentResolver();
        int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        try {
            resolver.takePersistableUriPermission(tree, flags);
        } catch (SecurityException e) {
            // algunas carpetas solo permiten lectura
            resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        JSObject ret = new JSObject();
        ret.put("uri", tree.toString());
        ret.put("name", folderName(tree));
        call.resolve(ret);
    }

    @PluginMethod
    public void listFolders(PluginCall call) {
        JSArray arr = new JSArray();
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (!p.isReadPermission()) continue;
            Uri tree = p.getUri();
            if (!DocumentsContract.isTreeUri(tree)) continue;
            JSObject o = new JSObject();
            o.put("uri", tree.toString());
            o.put("name", folderName(tree));
            o.put("writable", p.isWritePermission());
            arr.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("folders", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void removeFolder(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) { call.reject("Falta uri"); return; }
        Uri tree = Uri.parse(uri);
        ContentResolver resolver = getContext().getContentResolver();
        for (UriPermission p : resolver.getPersistedUriPermissions()) {
            if (p.getUri().equals(tree)) {
                int flags = (p.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0)
                    | (p.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
                resolver.releasePersistableUriPermission(tree, flags);
            }
        }
        call.resolve();
    }

    private String folderName(Uri tree) {
        try {
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            try (Cursor c = getContext().getContentResolver().query(doc,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) return c.getString(0);
            }
        } catch (Exception ignored) { }
        String id = DocumentsContract.getTreeDocumentId(tree);
        int i = id.lastIndexOf(':');
        return i >= 0 && i < id.length() - 1 ? id.substring(i + 1) : id;
    }

    // ---------- Escaneo ----------

    @PluginMethod
    public void scan(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) { call.reject("Falta uri"); return; }
        io.execute(() -> {
            try {
                Uri tree = Uri.parse(uri);
                JSArray files = new JSArray();
                walk(tree, DocumentsContract.getTreeDocumentId(tree), 0, files);
                JSObject ret = new JSObject();
                ret.put("files", files);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("No se pudo leer la carpeta: " + e.getMessage());
            }
        });
    }

    private void walk(Uri tree, String parentId, int depth, JSArray out) {
        if (depth > MAX_DEPTH) return;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] cols = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };
        ContentResolver resolver = getContext().getContentResolver();
        try (Cursor c = resolver.query(children, cols, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                if (name == null || name.startsWith(".")) continue;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    walk(tree, id, depth + 1, out);
                    continue;
                }
                String lower = name.toLowerCase(Locale.ROOT);
                if (!lower.endsWith(".pdf") && !lower.endsWith(".epub")) continue;
                long size = c.isNull(3) ? -1 : c.getLong(3);
                long modified = c.isNull(4) ? 0 : c.getLong(4);
                Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                String fp = cachedFingerprint(doc, size, modified);
                if (fp == null) continue;
                JSObject o = new JSObject();
                o.put("uri", doc.toString());
                o.put("name", name);
                o.put("size", size);
                o.put("modified", modified);
                o.put("fingerprint", fp);
                o.put("folder", tree.toString());
                out.put(o);
            }
        }
    }

    // La huella se guarda en caché por (uri, tamaño, fecha) para no releer los archivos en cada escaneo
    private String cachedFingerprint(Uri doc, long size, long modified) {
        SharedPreferences prefs = getContext().getSharedPreferences("huellas", Context.MODE_PRIVATE);
        String key = doc.toString() + "|" + size + "|" + modified;
        String cached = prefs.getString(key, null);
        if (cached != null) return cached;
        try {
            String fp = fingerprint(doc);
            prefs.edit().putString(key, fp).apply();
            return fp;
        } catch (Exception e) {
            return null;
        }
    }

    // Igual que fingerprint() en src/books.js: SHA-256 de "tamaño:" + primeros 2 MB + últimos 2 MB
    private String fingerprint(Uri doc) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(doc, "r")) {
            if (pfd == null) throw new IOException("sin descriptor");
            try (FileInputStream fis = new FileInputStream(pfd.getFileDescriptor())) {
                FileChannel ch = fis.getChannel();
                long size = pfd.getStatSize();
                if (size < 0) size = ch.size();
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                md.update((size + ":").getBytes(StandardCharsets.UTF_8));
                md.update(readRange(ch, 0, Math.min(size, CHUNK)));
                if (size > CHUNK) {
                    long start = Math.max(CHUNK, size - CHUNK);
                    md.update(readRange(ch, start, size - start));
                }
                byte[] hash = md.digest();
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < 16; i++) sb.append(String.format(Locale.ROOT, "%02x", hash[i]));
                return sb.toString();
            }
        }
    }

    private static byte[] readRange(FileChannel ch, long start, long length) throws IOException {
        ByteBuffer buf = ByteBuffer.allocate((int) length);
        ch.position(start);
        while (buf.hasRemaining()) {
            if (ch.read(buf) < 0) break;
        }
        byte[] out = new byte[buf.position()];
        buf.flip();
        buf.get(out);
        return out;
    }

    // ---------- Borrar archivo original ----------

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) { call.reject("Falta uri"); return; }
        io.execute(() -> {
            try {
                Uri doc = Uri.parse(uri);
                ContentResolver resolver = getContext().getContentResolver();
                if (!BookWebViewClient.isAllowed(resolver, doc)) { call.reject("Sin permiso sobre esa carpeta"); return; }
                boolean ok = DocumentsContract.deleteDocument(resolver, doc);
                JSObject ret = new JSObject();
                ret.put("deleted", ok);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("No se pudo borrar: " + e.getMessage());
            }
        });
    }

    // ---------- Orientación de pantalla ----------

    @PluginMethod
    public void setOrientation(PluginCall call) {
        String mode = call.getString("mode", "auto");
        int value = "vertical".equals(mode) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            : "horizontal".equals(mode) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        getActivity().runOnUiThread(() -> {
            getActivity().setRequestedOrientation(value);
            call.resolve();
        });
    }

    // ---------- Ingreso con Google ----------

    @PluginMethod
    public void googleSignIn(PluginCall call) {
        String clientId = call.getString("serverClientId");
        if (clientId == null || clientId.isEmpty()) { call.reject("Falta el ID de cliente web"); return; }
        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(clientId).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
        CredentialManager manager = CredentialManager.create(getContext());
        manager.getCredentialAsync(getActivity(), request, new CancellationSignal(), ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (credential instanceof CustomCredential
                        && GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        try {
                            GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(credential.getData());
                            JSObject ret = new JSObject();
                            ret.put("idToken", google.getIdToken());
                            ret.put("email", google.getId());
                            call.resolve(ret);
                        } catch (Exception e) {
                            call.reject("Respuesta de Google inválida: " + e.getMessage());
                        }
                    } else {
                        call.reject("Tipo de credencial inesperado");
                    }
                }

                @Override
                public void onError(GetCredentialException e) {
                    if (e instanceof GetCredentialCancellationException) call.reject("cancelled", "cancelled");
                    else call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), e.getType());
                }
            });
    }
}
