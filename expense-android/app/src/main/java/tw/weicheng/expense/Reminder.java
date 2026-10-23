package tw.weicheng.expense;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import java.util.Calendar;

/**
 * 每月 1 號 09:00 提醒「匯入上個月的載具發票」。
 * AlarmManager（不需要精確鬧鐘權限，允許 1 小時誤差）；開機、App 更新後重新排程；觸發後排下個月。
 */
public class Reminder extends BroadcastReceiver {
    static final String ACTION_REMIND = "tw.weicheng.expense.REMIND";
    private static final String CHANNEL = "monthly_invoice";
    private static final String PREF = "expense_reminder";

    @Override
    public void onReceive(Context c, Intent intent) {
        String a = intent != null ? intent.getAction() : null;
        if (ACTION_REMIND.equals(a)) {
            if (isOn(c)) post(c);
            schedule(c);
        } else if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            schedule(c);
        }
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    static boolean isOn(Context c) {
        return prefs(c).getBoolean("on", true);
    }

    static void setOn(Context c, boolean on) {
        prefs(c).edit().putBoolean("on", on).apply();
        schedule(c);
    }

    static boolean canNotify(Context c) {
        if (Build.VERSION.SDK_INT >= 33
                && c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        return nm == null || nm.areNotificationsEnabled();
    }

    /** 下一個「1 號 09:00」（今天是 1 號且還沒到 9 點就是今天）。 */
    static long nextFireTime(long now) {
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(now);
        cal.set(Calendar.DAY_OF_MONTH, 1);
        cal.set(Calendar.HOUR_OF_DAY, 9);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        if (cal.getTimeInMillis() <= now) cal.add(Calendar.MONTH, 1);
        return cal.getTimeInMillis();
    }

    static void schedule(Context c) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent pi = PendingIntent.getBroadcast(c, 0,
                new Intent(c, Reminder.class).setAction(ACTION_REMIND),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.cancel(pi);
        if (!isOn(c)) return;
        am.setWindow(AlarmManager.RTC_WAKEUP, nextFireTime(System.currentTimeMillis()), 60 * 60 * 1000L, pi);
    }

    /** 發出提醒通知；點了打開 App 的「匯入載具發票」步驟畫面。 */
    static void post(Context c) {
        if (!canNotify(c)) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "每月載具發票提醒", NotificationManager.IMPORTANCE_DEFAULT));
        Intent open = new Intent(c, MainActivity.class).setAction(MainActivity.ACTION_INVOICE_GUIDE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle("📄 匯入上個月的載具發票")
                .setContentText("點這裡：打開財政部平台匯出載具消費明細 CSV，分享給隨手記帳")
                .setStyle(new Notification.BigTextStyle().bigText("點這裡打開步驟：到財政部電子發票平台匯出上個月的載具消費明細 CSV，再分享給「隨手記帳」，就會自動分類並和刷卡紀錄合併。"))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        nm.notify(1001, n);
    }
}
