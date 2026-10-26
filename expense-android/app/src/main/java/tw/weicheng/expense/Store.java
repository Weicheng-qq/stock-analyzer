package tw.weicheng.expense;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * 通知收進來先存在這裡（SharedPreferences），等記帳畫面打開時由 JS 取走處理。
 * 只存聊天室名稱符合關鍵字（預設 富邦、華南）的 LINE 通知，其他聊天一律不碰。
 */
final class Store {
    private static final String PREF = "expense_store";
    private static final String K_PENDING = "pending";
    private static final String K_SEEN = "seen";
    private static final String K_KEYWORDS = "keywords";
    private static final String K_SHARED = "shared_text";
    private static final int MAX_PENDING = 500;
    private static final int MAX_SEEN = 400;

    private Store() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    static synchronized String[] keywords(Context c) {
        try {
            JSONArray a = new JSONArray(prefs(c).getString(K_KEYWORDS, "[\"富邦\",\"華南\"]"));
            String[] out = new String[a.length()];
            for (int i = 0; i < a.length(); i++) out[i] = a.getString(i);
            return out;
        } catch (JSONException e) {
            return new String[] {"富邦", "華南"};
        }
    }

    static synchronized void setKeywords(Context c, String json) {
        try {
            new JSONArray(json); // 驗證格式
            prefs(c).edit().putString(K_KEYWORDS, json).apply();
        } catch (JSONException ignored) {
        }
    }

    static boolean matches(Context c, CharSequence... texts) {
        String[] kws = keywords(c);
        for (CharSequence t : texts) {
            if (t == null) continue;
            String s = t.toString();
            for (String k : kws) if (!k.isEmpty() && s.contains(k)) return true;
        }
        return false;
    }

    /** 新增一則待處理訊息；同一則（同聊天室、同內容、同一分鐘）重複的通知只收一次。回傳是否為新訊息。 */
    static synchronized boolean add(Context c, String title, String text, long time) {
        SharedPreferences p = prefs(c);
        String key = title + "|" + text + "|" + (time / 60000L);
        String hash = Integer.toHexString(key.hashCode());
        try {
            JSONArray seen = new JSONArray(p.getString(K_SEEN, "[]"));
            for (int i = 0; i < seen.length(); i++) if (hash.equals(seen.getString(i))) return false;
            seen.put(hash);
            JSONArray trimmedSeen = new JSONArray();
            for (int i = Math.max(0, seen.length() - MAX_SEEN); i < seen.length(); i++) trimmedSeen.put(seen.get(i));

            JSONArray pending = new JSONArray(p.getString(K_PENDING, "[]"));
            JSONObject o = new JSONObject();
            o.put("id", hash + "-" + time);
            o.put("title", title);
            o.put("text", text);
            o.put("time", String.valueOf(time));
            pending.put(o);
            JSONArray trimmed = new JSONArray();
            for (int i = Math.max(0, pending.length() - MAX_PENDING); i < pending.length(); i++) trimmed.put(pending.get(i));

            p.edit().putString(K_SEEN, trimmedSeen.toString()).putString(K_PENDING, trimmed.toString()).apply();
            return true;
        } catch (JSONException e) {
            return false;
        }
    }

    static synchronized String pending(Context c) {
        return prefs(c).getString(K_PENDING, "[]");
    }

    /** JS 處理完（已存進記帳資料）才刪除，App 中途被關掉也不會漏記。 */
    static synchronized void ack(Context c, String idsJson) {
        try {
            JSONArray ids = new JSONArray(idsJson);
            Set<String> done = new HashSet<>();
            for (int i = 0; i < ids.length(); i++) done.add(ids.getString(i));
            JSONArray pending = new JSONArray(prefs(c).getString(K_PENDING, "[]"));
            JSONArray left = new JSONArray();
            for (int i = 0; i < pending.length(); i++) {
                JSONObject o = pending.getJSONObject(i);
                if (!done.contains(o.optString("id"))) left.put(o);
            }
            prefs(c).edit().putString(K_PENDING, left.toString()).apply();
        } catch (JSONException ignored) {
        }
    }

    // ---- 診斷：通知讀取是否連線中、最後運作時間 ----
    static void heartbeat(Context c) {
        long now = System.currentTimeMillis();
        SharedPreferences p = prefs(c);
        if (now - p.getLong("last_any", 0) > 60000L) p.edit().putLong("last_any", now).putBoolean("connected", true).apply();
    }

    static void setConnected(Context c, boolean on) {
        prefs(c).edit().putBoolean("connected", on).putLong(on ? "connected_at" : "disconnected_at", System.currentTimeMillis()).apply();
    }

    /** 連線中，且最近 2 小時內有運作（收到任何通知或剛連上）；三星有時會無聲無息把服務停掉。 */
    static boolean isConnected(Context c) {
        SharedPreferences p = prefs(c);
        long last = Math.max(p.getLong("last_any", 0), p.getLong("connected_at", 0));
        return p.getBoolean("connected", false) && System.currentTimeMillis() - last < 2 * 3600 * 1000L;
    }

    static String status(Context c) {
        SharedPreferences p = prefs(c);
        try {
            return new JSONObject().put("connected", p.getBoolean("connected", false))
                    .put("lastAny", p.getLong("last_any", 0)).toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    static synchronized void setShared(Context c, String text) {
        prefs(c).edit().putString(K_SHARED, text).apply();
    }

    static synchronized String takeShared(Context c) {
        String s = prefs(c).getString(K_SHARED, "");
        if (!s.isEmpty()) prefs(c).edit().remove(K_SHARED).apply();
        return s;
    }
}
