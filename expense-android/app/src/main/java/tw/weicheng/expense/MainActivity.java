package tw.weicheng.expense;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/** 外殼：用 WebView 顯示 assets/web/ 裡的記帳畫面（與網頁版同一份程式）。 */
public class MainActivity extends Activity {
    private static final String START_URL = "https://appassets.androidplatform.net/assets/web/index.html";
    private static final int REQ_FILE = 1001;
    static final String ACTION_INSTALL_STATUS = "tw.weicheng.expense.INSTALL_STATUS";
    static final String ACTION_INVOICE_GUIDE = "tw.weicheng.expense.INVOICE_GUIDE";
    /** 點了每月提醒通知 → 畫面開好後由 JS 取走，顯示匯入步驟。 */
    static volatile String launchAction = "";
    private static long lastUpdateCheck = 0;
    private static WeakReference<MainActivity> current = new WeakReference<>(null);

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    /** 通知服務收到新交易時呼叫：畫面開著就馬上處理。 */
    static void notifyNewData() {
        MainActivity a = current.get();
        if (a != null) a.runOnUiThread(a::pushToJs);
    }

    static void toastFromNative(String msg) {
        MainActivity a = current.get();
        if (a != null) a.runOnUiThread(() -> a.js("window.__nativeToast && window.__nativeToast(" + org.json.JSONObject.quote(msg) + ")"));
    }

    private void js(String code) {
        if (web != null) web.evaluateJavascript(code, null);
    }

    /** 每次開 App（最多 1 分鐘一次）檢查更新。 */
    private void checkUpdate() {
        long now = System.currentTimeMillis();
        if (now - lastUpdateCheck < 60 * 1000L) return;
        lastUpdateCheck = now;
        Updater.checkAsync(this,
                () -> runOnUiThread(() -> js("window.__updateReady && window.__updateReady()")),
                () -> runOnUiThread(() -> js("window.__nativeUpdate && window.__nativeUpdate()")));
    }

    /** 設定頁「檢查更新」按鈕：不管多久前檢查過，立刻再查一次。 */
    void forceCheckUpdate() {
        lastUpdateCheck = 0;
        checkUpdate();
    }

    /** 系統安裝程式回報狀態：需要使用者確認就把確認畫面叫出來。 */
    private boolean handleInstallStatus(Intent intent) {
        if (intent == null || !ACTION_INSTALL_STATUS.equals(intent.getAction())) return false;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) startActivity(confirm);
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            String m = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            toastFromNative("更新沒有完成" + (m != null ? "：" + m : ""));
        }
        return true;
    }

    private void pushToJs() {
        if (web != null) web.evaluateJavascript("window.__nativePush && window.__nativePush()", null);
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#0F766E"));
        current = new WeakReference<>(this);
        Updater.checkBoot(this);
        Reminder.schedule(this);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new Updater.LivePathHandler(this))
                .build();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 記帳資料存在 localStorage
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.addJavascriptInterface(new Bridge(this), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u)); // 外部連結用瀏覽器開
                } catch (Exception ignored) {
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "選擇檔案"), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        setContentView(web);
        handleShare(getIntent());
        handleGuide(getIntent());
        web.loadUrl(START_URL);
        handleInstallStatus(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (handleInstallStatus(intent)) return;
        if (handleGuide(intent)) { pushToJs(); return; }
        if (handleShare(intent)) pushToJs();
    }

    @Override
    protected void onResume() {
        super.onResume();
        current = new WeakReference<>(this);
        pushToJs();
        checkUpdate();
    }

    private boolean handleGuide(Intent intent) {
        if (intent == null || !ACTION_INVOICE_GUIDE.equals(intent.getAction())) return false;
        launchAction = "invoice";
        intent.setAction(Intent.ACTION_MAIN);
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        js("window.__permChanged && window.__permChanged()");
    }

    /** 收到「分享」進來的 LINE 聊天記錄或載具明細檔：存起來，等 JS 取走匯入。 */
    private boolean handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return false;
        String text = null;
        Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri != null) text = readUri(uri);
        if (text == null) {
            CharSequence t = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (t != null) text = t.toString();
        }
        intent.setAction(Intent.ACTION_MAIN); // 避免轉螢幕時重複匯入
        if (text == null || text.isEmpty()) return false;
        Store.setShared(this, text);
        return true;
    }

    private String readUri(Uri uri) {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > 20 * 1024 * 1024) break; // 上限 20MB
            }
            byte[] b = bos.toByteArray();
            String s = new String(b, StandardCharsets.UTF_8);
            if (s.indexOf('�') >= 0) {
                try {
                    s = new String(b, Charset.forName("Big5")); // 舊版財政部匯出檔可能是 Big5
                } catch (Exception ignored) {
                }
            }
            return s.startsWith("﻿") ? s.substring(1) : s;
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__onBack ? window.__onBack() : false", v -> {
            if (!"true".equals(v)) MainActivity.super.onBackPressed();
        });
    }
}
