package tw.weicheng.expense;

import android.app.Notification;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

/**
 * 監聽通知：LINE 銀行官方帳號（聊天室名稱含關鍵字）＋銀行 App 推播／銀行簡訊（含關鍵字），交給 Store 暫存。
 * 解析金額、分類等全部在 JS（parse.js）做，Android 端只負責「原文照抄」。
 */
public class NotifyService extends NotificationListenerService {
    static final String LINE_PKG = "jp.naver.line.android";

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            if (sbn == null) return;
            Store.heartbeat(this); // 診斷用：通知讀取「最後一次有在運作」的時間（不記內容）
            String pkg = sbn.getPackageName();
            if (pkg == null || pkg.equals(getPackageName())) return;
            Notification n = sbn.getNotification();
            if (n == null) return;
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return; // 「N 則新訊息」摘要，內容在個別通知裡
            if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) return; // 常駐通知（下載中、播放中…）不是交易
            Bundle ex = n.extras;
            if (ex == null) return;
            boolean added = LINE_PKG.equals(pkg) ? fromLine(sbn, ex) : fromOtherApp(sbn, ex, pkg);
            if (added) MainActivity.notifyNewData();
        } catch (Exception ignored) {
            // 任何意外都不能讓服務崩潰，否則系統會停止通知監聽
        }
    }

    /** LINE：只收「聊天室名稱」含關鍵字的（銀行官方帳號），私人聊天就算提到銀行也不收。 */
    private boolean fromLine(StatusBarNotification sbn, Bundle ex) {
        CharSequence title = ex.getCharSequence(Notification.EXTRA_TITLE);
        CharSequence conv = ex.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE);
        String chat = conv != null ? conv.toString() : (title != null ? title.toString() : "");
        boolean added = false;

        // MessagingStyle：一則通知可能帶好幾則訊息，各有自己的時間
        Parcelable[] msgs = ex.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (msgs != null && msgs.length > 0) {
            for (Parcelable p : msgs) {
                if (!(p instanceof Bundle)) continue;
                Bundle m = (Bundle) p;
                CharSequence text = m.getCharSequence("text");
                CharSequence sender = m.getCharSequence("sender");
                long time = m.getLong("time", sbn.getPostTime());
                if (text == null) continue;
                if (!Store.matches(this, chat, sender)) continue;
                String who = chat.isEmpty() && sender != null ? sender.toString() : chat;
                added |= Store.add(this, who, text.toString(), time);
            }
            return added;
        }
        CharSequence text = bodyOf(ex);
        if (text != null && Store.matches(this, chat, title)) {
            added = Store.add(this, chat, text.toString(), sbn.getPostTime());
        }
        return added;
    }

    /**
     * 銀行 App 推播、銀行簡訊：LINE 的銀行卡片訊息在通知裡只有一句摘要（沒有金額），
     * 銀行自己的 App 推播與簡訊通常有金額。App 名稱、通知標題或內容含關鍵字（富邦、華南）才收。
     */
    private boolean fromOtherApp(StatusBarNotification sbn, Bundle ex, String pkg) {
        CharSequence title = ex.getCharSequence(Notification.EXTRA_TITLE);
        CharSequence text = bodyOf(ex);
        if (text == null || text.length() == 0) return false;
        String label = appLabel(pkg);
        if (!Store.matches(this, label, title, text)) return false;
        String who = Store.matches(this, label) ? label : (title != null ? title.toString() : label);
        String body = title != null && !who.equals(title.toString()) ? title + "\n" + text : text.toString();
        return Store.add(this, who, body, sbn.getPostTime());
    }

    private static CharSequence bodyOf(Bundle ex) {
        CharSequence big = ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if (big != null && big.length() > 0) return big;
        CharSequence[] lines = ex.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
        if (lines != null && lines.length > 0) {
            StringBuilder sb = new StringBuilder();
            for (CharSequence l : lines) if (l != null) sb.append(sb.length() > 0 ? "\n" : "").append(l);
            return sb;
        }
        return ex.getCharSequence(Notification.EXTRA_TEXT);
    }

    private String appLabel(String pkg) {
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    @Override
    public void onListenerConnected() {
        Store.setConnected(this, true);
    }

    @Override
    public void onListenerDisconnected() {
        // 被系統斷開時要求重新連線
        Store.setConnected(this, false);
        requestRebind(new ComponentName(this, NotifyService.class));
    }

    /**
     * App 更新後 Android 有時不會自動接回通知讀取（使用者已授權、但服務沒在跑）。
     * 打開 App 時呼叫：停用再啟用元件，逼系統重新綁定。
     */
    static void ensureConnected(android.content.Context c) {
        ComponentName cn = new ComponentName(c, NotifyService.class);
        if (Store.isConnected(c)) return;
        android.content.pm.PackageManager pm = c.getPackageManager();
        pm.setComponentEnabledSetting(cn, android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED, android.content.pm.PackageManager.DONT_KILL_APP);
        pm.setComponentEnabledSetting(cn, android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED, android.content.pm.PackageManager.DONT_KILL_APP);
        requestRebind(cn);
    }
}
