package tw.weicheng.expense;

import android.app.Notification;
import android.content.ComponentName;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

/**
 * 監聽 LINE 的通知：聊天室名稱（富邦、華南…）符合關鍵字才收下，交給 Store 暫存。
 * 解析金額、分類等全部在 JS（parse.js）做，Android 端只負責「原文照抄」。
 */
public class NotifyService extends NotificationListenerService {
    static final String LINE_PKG = "jp.naver.line.android";

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            if (sbn == null || !LINE_PKG.equals(sbn.getPackageName())) return;
            Notification n = sbn.getNotification();
            if (n == null) return;
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return; // 「N 則新訊息」摘要，內容在個別通知裡
            Bundle ex = n.extras;
            if (ex == null) return;

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
            } else {
                CharSequence big = ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
                CharSequence text = big != null ? big : ex.getCharSequence(Notification.EXTRA_TEXT);
                if (text != null && Store.matches(this, chat, title)) {
                    added = Store.add(this, chat, text.toString(), sbn.getPostTime());
                }
            }
            if (added) MainActivity.notifyNewData();
        } catch (Exception ignored) {
            // 任何意外都不能讓服務崩潰，否則系統會停止通知監聽
        }
    }

    @Override
    public void onListenerDisconnected() {
        // 被系統斷開時要求重新連線
        requestRebind(new ComponentName(this, NotifyService.class));
    }
}
