package com.imagineluc.xunji;

import android.app.AppOpsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Process;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.text.Collator;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@CapacitorPlugin(name = "UsageStats")
public class UsageStatsPlugin extends Plugin {
    @PluginMethod
    public void hasUsageAccess(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasUsageAccess());
        call.resolve(result);
    }

    @PluginMethod
    public void openUsageAccessSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (Exception ignored) {
            Intent fallback = new Intent(Settings.ACTION_SETTINGS);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(fallback);
        }
        call.resolve();
    }

    @PluginMethod
    public void getInstalledApps(PluginCall call) {
        PackageManager packageManager = getContext().getPackageManager();
        Intent launcherIntent = new Intent(Intent.ACTION_MAIN, null);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> activities = packageManager.queryIntentActivities(launcherIntent, PackageManager.MATCH_ALL);
        Map<String, JSObject> uniqueApps = new HashMap<>();

        for (ResolveInfo activity : activities) {
            if (activity.activityInfo == null || activity.activityInfo.applicationInfo == null) continue;
            String packageName = activity.activityInfo.packageName;
            if (packageName.equals(getContext().getPackageName())) continue;
            CharSequence labelValue = activity.loadLabel(packageManager);
            String label = labelValue == null ? packageName : labelValue.toString().trim();
            ApplicationInfo appInfo = activity.activityInfo.applicationInfo;
            JSObject app = new JSObject();
            app.put("packageName", packageName);
            app.put("label", label.isEmpty() ? packageName : label);
            app.put("system", (appInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0);
            uniqueApps.put(packageName, app);
        }

        List<JSObject> apps = new ArrayList<>(uniqueApps.values());
        Collator collator = Collator.getInstance();
        Collections.sort(apps, Comparator.comparing(app -> app.optString("label"), collator));
        JSArray result = new JSArray();
        for (JSObject app : apps) result.put(app);
        JSObject response = new JSObject();
        response.put("apps", result);
        call.resolve(response);
    }

    @PluginMethod
    public void getUsageForPackages(PluginCall call) {
        if (!hasUsageAccess()) {
            call.reject("USAGE_ACCESS_REQUIRED");
            return;
        }

        JSArray requested = call.getArray("packageNames");
        if (requested == null) {
            call.reject("packageNames is required");
            return;
        }
        Set<String> packageNames = new HashSet<>();
        try {
            for (int index = 0; index < requested.length(); index++) {
                String packageName = requested.getString(index);
                if (packageName != null && !packageName.isEmpty()) packageNames.add(packageName);
            }
        } catch (JSONException error) {
            call.reject("Invalid packageNames", error);
            return;
        }

        long endTime = call.getData().optLong("endTime", System.currentTimeMillis());
        long startTime = call.getData().optLong("startTime", endTime - 24L * 60L * 60L * 1000L);
        if (startTime >= endTime) {
            call.reject("startTime must be before endTime");
            return;
        }

        UsageStatsManager manager = (UsageStatsManager) getContext().getSystemService(Context.USAGE_STATS_SERVICE);
        Map<String, UsageStats> aggregate = manager == null
            ? Collections.emptyMap()
            : manager.queryAndAggregateUsageStats(startTime, endTime);
        JSArray usage = new JSArray();
        for (String packageName : packageNames) {
            UsageStats stats = aggregate.get(packageName);
            JSObject item = new JSObject();
            item.put("packageName", packageName);
            item.put("usageMs", stats == null ? 0 : Math.max(0, stats.getTotalTimeInForeground()));
            item.put("lastTimeUsed", stats == null ? 0 : stats.getLastTimeUsed());
            usage.put(item);
        }
        JSObject response = new JSObject();
        response.put("usage", usage);
        call.resolve(response);
    }

    private boolean hasUsageAccess() {
        AppOpsManager appOps = (AppOpsManager) getContext().getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) return false;
        int mode = appOps.checkOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            getContext().getPackageName()
        );
        return mode == AppOpsManager.MODE_ALLOWED;
    }
}
