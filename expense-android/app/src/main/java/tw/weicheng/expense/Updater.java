package tw.weicheng.expense;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 自動更新。GitHub Actions 每次編譯都把 update.json、web.zip、expense-app.apk 放到固定的 Release。
 * ① 畫面程式（expense/ 的 HTML/JS/CSS）有新版：背景下載 web.zip、驗證 SHA-256、解壓到 files/web-live，
 *    之後由 LivePathHandler 優先提供 → 使用者什麼都不用做。
 * ② Android 主程式（expense-android/）有新版：只能請使用者按一次「更新」，用 PackageInstaller 安裝。
 * 安全網：新畫面載入後 JS 要呼叫 bootOk()；若某版沒有成功啟動，下次開 App 自動退回 APK 內建版本。
 */
final class Updater {
    private static final String BASE = "https://github.com/Weicheng-qq/stock-analyzer/releases/download/expense-app-latest/";
    private static final String PREF = "expense_update";
    private static final String K_LIVE = "live_hash";       // 目前使用中的線上畫面版本
    private static final String K_PENDING = "pending_boot"; // 剛換上、還沒確認能正常啟動的版本
    private static final String K_BAD = "bad_hash";         // 啟動失敗過、不要再用的版本
    static volatile JSONObject latest;                      // 最近一次抓到的 update.json

    private Updater() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    static File liveDir(Context c) {
        return new File(c.getFilesDir(), "web-live");
    }

    /**
     * App 啟動時呼叫。
     * - APK 剛更新（內建畫面版本變了）：舊的線上畫面作廢，改用新 APK 內建的。
     * - 新換上的線上畫面連續 2 次啟動都沒回報 bootOk（JS 壞掉）：丟掉它、退回內建版本、這一版不再下載。
     */
    static void checkBoot(Context c) {
        SharedPreferences p = prefs(c);
        if (!BuildConfig.WEB_HASH.equals(p.getString("bundled_hash", ""))) {
            deleteTree(liveDir(c));
            p.edit().clear().putString("bundled_hash", BuildConfig.WEB_HASH).apply();
            return;
        }
        String pending = p.getString(K_PENDING, "");
        if (pending.isEmpty()) return;
        int tries = p.getInt("boot_tries", 0) + 1;
        if (tries >= 3) {
            deleteTree(liveDir(c));
            p.edit().remove(K_PENDING).remove(K_LIVE).remove("boot_tries").putString(K_BAD, pending).apply();
        } else {
            p.edit().putInt("boot_tries", tries).apply();
        }
    }

    static void bootOk(Context c) {
        prefs(c).edit().remove(K_PENDING).remove("boot_tries").apply();
    }

    static String currentWebHash(Context c) {
        String live = prefs(c).getString(K_LIVE, "");
        return live.isEmpty() ? BuildConfig.WEB_HASH : live;
    }

    /** 背景檢查更新。回呼 onWebUpdated：畫面新版已就緒（可重新整理）。 */
    static void checkAsync(Context c, Runnable onWebUpdated, Runnable onNativeAvailable) {
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                JSONObject u = new JSONObject(new String(download(BASE + "update.json", 64 * 1024), StandardCharsets.UTF_8));
                latest = u;
                String nativeHash = u.optString("nativeHash");
                if (!nativeHash.isEmpty() && !nativeHash.equals(BuildConfig.NATIVE_HASH)
                        && u.optInt("versionCode") > BuildConfig.VERSION_CODE) {
                    // 主程式有新版：新畫面可能依賴新的主程式功能，所以先不換畫面，只提示更新 App
                    onNativeAvailable.run();
                    return;
                }
                String webHash = u.optString("webHash");
                if (webHash.isEmpty() || webHash.equals(currentWebHash(app)) || webHash.equals(prefs(app).getString(K_BAD, ""))) return;
                byte[] zip = download(BASE + "web.zip", 20 * 1024 * 1024);
                if (!sha256(zip).equalsIgnoreCase(u.optString("webZipSha256"))) return; // 下載不完整或被竄改
                File tmp = new File(app.getFilesDir(), "web-tmp");
                deleteTree(tmp);
                unzip(zip, tmp);
                if (!new File(tmp, "index.html").exists()) return;
                File live = liveDir(app);
                deleteTree(live);
                if (!tmp.renameTo(live)) return;
                if (webHash.equals(BuildConfig.WEB_HASH)) { // 線上版剛好等於內建版：直接用內建的
                    deleteTree(live);
                    prefs(app).edit().remove(K_LIVE).remove(K_PENDING).apply();
                } else {
                    prefs(app).edit().putString(K_LIVE, webHash).putString(K_PENDING, webHash).remove("boot_tries").apply();
                }
                onWebUpdated.run();
            } catch (Exception ignored) {
                // 沒網路或 GitHub 連不上：照用目前版本，下次再試
            }
        }).start();
    }

    /** 主程式更新：下載 APK → 交給系統安裝（系統會跳出確認畫面）。回傳給使用者看的訊息。 */
    static String installApk(Activity act) {
        if (Build.VERSION.SDK_INT >= 26 && !act.getPackageManager().canRequestPackageInstalls()) {
            act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + act.getPackageName())));
            return "請先允許「隨手記帳」安裝應用程式，返回後再按一次更新";
        }
        new Thread(() -> {
            try {
                byte[] apk = download(BASE + "expense-app.apk", 60 * 1024 * 1024);
                PackageInstaller pi = act.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(act.getPackageName());
                int id = pi.createSession(params);
                try (PackageInstaller.Session s = pi.openSession(id)) {
                    try (OutputStream os = s.openWrite("expense-app.apk", 0, apk.length)) {
                        os.write(apk);
                        s.fsync(os);
                    }
                    Intent cb = new Intent(act, MainActivity.class).setAction(MainActivity.ACTION_INSTALL_STATUS);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    s.commit(PendingIntent.getActivity(act, id, cb, flags).getIntentSender());
                }
            } catch (Exception e) {
                MainActivity.toastFromNative("下載新版失敗，請稍後再試：" + e.getMessage());
            }
        }).start();
        return "正在下載新版…";
    }

    private static byte[] download(String url, int max) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true); // GitHub Release 會轉址到 objects.githubusercontent.com（同為 https）
        c.setRequestProperty("Cache-Control", "no-cache");
        try (InputStream in = c.getInputStream()) {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > max) throw new Exception("檔案過大");
            }
            return bos.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    private static String sha256(byte[] b) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static void unzip(byte[] zip, File dir) throws Exception {
        String root = dir.getCanonicalPath() + File.separator;
        try (ZipInputStream zin = new ZipInputStream(new java.io.ByteArrayInputStream(zip))) {
            ZipEntry e;
            byte[] buf = new byte[16384];
            while ((e = zin.getNextEntry()) != null) {
                File f = new File(dir, e.getName());
                if (!f.getCanonicalPath().startsWith(root)) throw new Exception("壓縮檔路徑不合法"); // 防 zip slip
                if (e.isDirectory()) { f.mkdirs(); continue; }
                File parent = f.getParentFile();
                if (parent != null) parent.mkdirs();
                try (FileOutputStream os = new FileOutputStream(f)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    /** /assets/web/… 先找下載好的新版畫面，沒有才用 APK 內建的。 */
    static final class LivePathHandler implements WebViewAssetLoader.PathHandler {
        private final Context ctx;
        private final WebViewAssetLoader.AssetsPathHandler assets;

        LivePathHandler(Context ctx) {
            this.ctx = ctx;
            this.assets = new WebViewAssetLoader.AssetsPathHandler(ctx);
        }

        @Override
        public WebResourceResponse handle(String path) {
            if (path.startsWith("web/") && !prefs(ctx).getString(K_LIVE, "").isEmpty()) {
                File live = liveDir(ctx);
                File f = new File(live, path.substring(4));
                try {
                    if (f.getCanonicalPath().startsWith(live.getCanonicalPath() + File.separator) && f.isFile()) {
                        WebResourceResponse r = new WebResourceResponse(mime(path), mime(path).startsWith("text/") || path.endsWith(".js") || path.endsWith(".json") ? "utf-8" : null, new FileInputStream(f));
                        java.util.Map<String, String> h = new java.util.HashMap<>();
                        h.put("Cache-Control", "no-cache");
                        r.setResponseHeaders(h);
                        return r;
                    }
                } catch (Exception ignored) {
                }
            }
            return assets.handle(path);
        }

        private static String mime(String p) {
            if (p.endsWith(".html")) return "text/html";
            if (p.endsWith(".js")) return "application/javascript";
            if (p.endsWith(".css")) return "text/css";
            if (p.endsWith(".json")) return "application/json";
            if (p.endsWith(".svg")) return "image/svg+xml";
            if (p.endsWith(".png")) return "image/png";
            return "application/octet-stream";
        }
    }
}
