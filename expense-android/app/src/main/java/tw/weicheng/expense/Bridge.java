package tw.weicheng.expense;

import android.app.Activity;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** 給記帳畫面（JS）呼叫的 window.AndroidBridge。 */
final class Bridge {
    private final Activity act;

    Bridge(Activity act) {
        this.act = act;
    }

    @JavascriptInterface
    public boolean isListenerEnabled() {
        String flat = Settings.Secure.getString(act.getContentResolver(), "enabled_notification_listeners");
        if (flat == null) return false;
        String me = new ComponentName(act, NotifyService.class).flattenToString();
        for (String s : flat.split(":")) {
            if (s.equals(me)) return true;
            ComponentName cn = ComponentName.unflattenFromString(s);
            if (cn != null && cn.getPackageName().equals(act.getPackageName())) return true;
        }
        return false;
    }

    @JavascriptInterface
    public void openListenerSettings() {
        act.startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
    }

    @JavascriptInterface
    public void openBatterySettings() {
        try {
            act.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        } catch (Exception e) {
            act.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + act.getPackageName())));
        }
    }

    @JavascriptInterface
    public String getPending() {
        return Store.pending(act);
    }

    @JavascriptInterface
    public void ack(String idsJson) {
        Store.ack(act, idsJson);
    }

    @JavascriptInterface
    public void setKeywords(String json) {
        Store.setKeywords(act, json);
    }

    @JavascriptInterface
    public String takeSharedText() {
        return Store.takeShared(act);
    }

    /** 畫面成功啟動（自動更新的安全網用）。 */
    @JavascriptInterface
    public void bootOk() {
        Updater.bootOk(act);
    }

    /** 下載並安裝新版 App（系統會跳出確認）。 */
    @JavascriptInterface
    public String installUpdate() {
        return Updater.installApk(act);
    }

    @JavascriptInterface
    public String appVersion() {
        String w = Updater.currentWebHash(act);
        return BuildConfig.VERSION_NAME + "（畫面 " + (w.length() > 7 ? w.substring(0, 7) : w) + "）";
    }

    /** 備份／匯出：存到手機的「下載」資料夾。 */
    @JavascriptInterface
    public String saveFile(String name, String text) {
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        String mime = name.endsWith(".csv") ? "text/csv" : name.endsWith(".json") ? "application/json" : "text/plain";
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                Uri uri = act.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return "儲存失敗";
                try (OutputStream os = act.getContentResolver().openOutputStream(uri)) {
                    if (os == null) return "儲存失敗";
                    os.write(data);
                }
                return "已儲存到「下載」資料夾：" + name;
            }
            File dir = act.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File f = new File(dir, name);
            try (FileOutputStream os = new FileOutputStream(f)) {
                os.write(data);
            }
            return "已儲存：" + f.getAbsolutePath();
        } catch (Exception e) {
            return "儲存失敗：" + e.getMessage();
        }
    }
}
