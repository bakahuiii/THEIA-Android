package io.github.bakahuiii.theia.basic;

import android.app.Dialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import android.util.Base64;

@CapacitorPlugin(name = "CasAuth")
public class CasAuthPlugin extends Plugin {
    private static final String JWGLXT_HOST = "jwglxt.buct.edu.cn";
    private static final String JWGLXT_COOKIE_URL = "https://jwglxt.buct.edu.cn/";
    private static final String CAS_COOKIE_URL = "https://experimental-auth-endpoint.buct.edu.cn/";
    private static final String PORTAL_COOKIE_URL = "https://portal.buct.edu.cn/";
    private static final String THEOL_HOST = "course.buct.edu.cn";
    private static final String THEOL_COOKIE_URL = "https://course.buct.edu.cn/";
    private static final String THEOL_HOME_URL = "https://course.buct.edu.cn/meol/homepage/common/sso_login.jsp";
    private static final long THEOL_BOOTSTRAP_DELAY_MS = 500L;
    private static final long THEOL_RETRY_DELAY_MS = 1200L;
    private static final long THEOL_FALLBACK_DELAY_MS = 20000L;
    private static final long THEOL_AUTOMATIC_TIMEOUT_MS = 10000L;
    private static final long CAS_AUTOMATIC_TIMEOUT_MS = 30000L;
    private static final int THEOL_RETRY_LIMIT = 14;
    private static final String SESSION_KEY_ALIAS = "theia-basic-session-key";
    private static final String SESSION_PREFS = "theia-basic-secure-session";
    private static final String SESSION_IV = "iv";
    private static final String SESSION_VALUE = "value";
    private static final String[] AUTH_STORAGE_ORIGINS = new String[] {
            "https://experimental-auth-endpoint.buct.edu.cn",
            "https://portal.buct.edu.cn",
            "https://jwglxt.buct.edu.cn",
            "https://course.buct.edu.cn",
            "http://course.buct.edu.cn"
    };

    private Dialog loginDialog;
    private WebView loginWebView;
    private TextView statusView;
    private PluginCall pendingCall;
    private boolean completed;
    private boolean bootstrapTheolAfterCas;
    private boolean waitingForTheol;
    private boolean autoTheolAttempted;
    private boolean theolFallbackScheduled;
    private boolean theolRetryScheduled;
    private int theolRetryCount;
    private boolean academicRequired;
    private boolean theolRequired;
    private boolean automaticTheolExpected;
    private boolean automaticTheolOnly;
    private boolean automaticCasOnly;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void login(PluginCall call) {
        if (pendingCall != null) {
            call.reject("统一身份认证页面已经打开");
            return;
        }
        String rawUrl = call.getString("url", "");
        if (!isTrustedUrl(rawUrl)) {
            call.reject("统一身份认证地址不受信任");
            return;
        }
        pendingCall = call;
        completed = false;
        String seedCookieHeader = call.getString("cookieHeader", "");
        String seedAcademicCookieHeader = call.getString("academicCookieHeader", "");
        String seedTheolCookieHeader = call.getString("theolCookieHeader", "");
        automaticTheolOnly = Boolean.TRUE.equals(call.getBoolean("automaticTheol", false));
        automaticCasOnly = Boolean.TRUE.equals(call.getBoolean("automaticCas", false));
        // CAS starts from the unified auth endpoint, so the initial URL does
        // not necessarily contain the JWGLXT host. THEOL login starts on its
        // own host and must remain a direct login flow.
        bootstrapTheolAfterCas = !rawUrl.contains(THEOL_HOST) && !automaticTheolOnly && !automaticCasOnly;
        automaticTheolExpected = bootstrapTheolAfterCas || automaticTheolOnly;
        academicRequired = !rawUrl.contains(THEOL_HOST) && !automaticTheolOnly;
        theolRequired = rawUrl.contains(THEOL_HOST) || automaticTheolOnly;
        waitingForTheol = false;
        autoTheolAttempted = false;
        theolFallbackScheduled = false;
        theolRetryScheduled = false;
        theolRetryCount = 0;
        getActivity().runOnUiThread(() -> {
            Runnable load = () -> showLoginPage(rawUrl);
            if (automaticTheolOnly) {
                seedCookies(CAS_COOKIE_URL, seedCookieHeader, () ->
                        seedCookies(PORTAL_COOKIE_URL, seedCookieHeader, () ->
                                seedCookies(JWGLXT_COOKIE_URL, seedAcademicCookieHeader, () ->
                                        seedCookies(THEOL_COOKIE_URL, seedTheolCookieHeader, load))));
            } else if (automaticCasOnly) {
                seedCookies(CAS_COOKIE_URL, seedCookieHeader, () ->
                        seedCookies(PORTAL_COOKIE_URL, seedCookieHeader, () ->
                                seedCookies(JWGLXT_COOKIE_URL, seedAcademicCookieHeader, load)));
            } else {
                load.run();
            }
        });
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            CookieManager manager = CookieManager.getInstance();
            manager.removeAllCookies(value -> {
                manager.flush();
                for (String origin : AUTH_STORAGE_ORIGINS) WebStorage.getInstance().deleteOrigin(origin);
                secureSessionPreferences().edit().clear().commit();
                call.resolve();
            });
        });
    }

    @PluginMethod
    public void saveSession(PluginCall call) {
        String value = call.getString("value", "");
        if (value == null || value.trim().isEmpty()) {
            call.reject("校园会话为空");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, sessionKey());
            SharedPreferences preferences = secureSessionPreferences();
            preferences.edit()
                    .putString(SESSION_IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                    .putString(SESSION_VALUE, Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP))
                    .commit();
            call.resolve();
        } catch (Exception error) {
            call.reject("校园会话安全保存失败");
        }
    }

    @PluginMethod
    public void getSavedSession(PluginCall call) {
        try {
            SharedPreferences preferences = secureSessionPreferences();
            String iv = preferences.getString(SESSION_IV, "");
            String value = preferences.getString(SESSION_VALUE, "");
            String decoded = "";
            if (!iv.isEmpty() && !value.isEmpty()) {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, sessionKey(), new GCMParameterSpec(128, Base64.decode(iv, Base64.DEFAULT)));
                decoded = new String(cipher.doFinal(Base64.decode(value, Base64.DEFAULT)), StandardCharsets.UTF_8);
            }
            JSObject result = new JSObject();
            result.put("value", decoded);
            call.resolve(result);
        } catch (Exception error) {
            // A transient Keystore/bridge failure must not destroy the only
            // recoverable session. Let the JS layer retry while retaining it.
            call.reject("校园会话安全读取失败");
        }
    }

    @PluginMethod
    public void clearSavedSession(PluginCall call) {
        secureSessionPreferences().edit().clear().commit();
        call.resolve();
    }

    @PluginMethod
    public void getCookies(PluginCall call) {
        Runnable read = () -> {
            CookieManager.getInstance().flush();
            String casCookies = casCookies();
            String jwglxtCookies = academicCookies();
            String theolCookies = theolCookies();
            JSObject result = new JSObject();
            result.put("casCookies", casCookies);
            result.put("cookies", mergeCookieHeaders(jwglxtCookies, theolCookies));
            result.put("jwglxtCookies", jwglxtCookies);
            result.put("theolCookies", theolCookies);
            result.put("theolConnected", !theolCookies.trim().isEmpty());
            call.resolve(result);
        };
        if (Looper.myLooper() == Looper.getMainLooper()) read.run();
        else getActivity().runOnUiThread(read);
    }

    private void showLoginPage(String url) {
        if (getActivity() == null || pendingCall == null) return;

        LinearLayout root = new LinearLayout(getActivity());
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout toolbar = new LinearLayout(getActivity());
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(18), dp(10), dp(10), dp(10));
        toolbar.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(getActivity());
        title.setText("统一身份认证");
        title.setTextColor(Color.rgb(22, 27, 33));
        title.setTextSize(18);
        title.setTypeface(null, 1);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));

        Button close = new Button(getActivity());
        close.setText("取消");
        close.setTextColor(Color.rgb(45, 103, 96));
        close.setAllCaps(false);
        close.setOnClickListener(view -> rejectAndClose("用户取消了统一身份认证"));
        toolbar.addView(close, new LinearLayout.LayoutParams(dp(72), dp(48)));
        root.addView(toolbar, new LinearLayout.LayoutParams(-1, dp(68)));

        statusView = new TextView(getActivity());
        statusView.setText("正在加载认证页面…");
        statusView.setTextColor(Color.rgb(100, 110, 118));
        statusView.setTextSize(12);
        statusView.setGravity(Gravity.CENTER_VERTICAL);
        statusView.setPadding(dp(18), 0, dp(18), 0);
        root.addView(statusView, new LinearLayout.LayoutParams(-1, dp(34)));

        FrameLayout content = new FrameLayout(getActivity());
        ProgressBar progress = new ProgressBar(getActivity());
        progress.setIndeterminate(true);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(dp(32), dp(32), Gravity.CENTER);
        content.addView(progress, progressParams);

        loginWebView = new WebView(getActivity());
        WebSettings settings = loginWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(loginWebView, true);
        loginWebView.setWebChromeClient(new WebChromeClient());
        loginWebView.setWebViewClient(new CasWebViewClient(progress));
        content.addView(loginWebView, new FrameLayout.LayoutParams(-1, -1));
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));

        loginDialog = new Dialog(getActivity());
        loginDialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        loginDialog.setContentView(root);
        loginDialog.setCanceledOnTouchOutside(false);
        loginDialog.setOnDismissListener(dialog -> {
            handler.removeCallbacksAndMessages(null);
            if (!completed && pendingCall != null) {
                PluginCall call = pendingCall;
                pendingCall = null;
                call.reject("统一身份认证页面已关闭");
            }
            destroyWebView();
            bootstrapTheolAfterCas = false;
            waitingForTheol = false;
            autoTheolAttempted = false;
            theolFallbackScheduled = false;
            theolRetryScheduled = false;
            theolRetryCount = 0;
            academicRequired = false;
            theolRequired = false;
            automaticTheolExpected = false;
            automaticTheolOnly = false;
            automaticCasOnly = false;
            statusView = null;
            loginDialog = null;
        });
        Window window = loginDialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.WHITE));
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
        }
        loginDialog.show();
        if (loginDialog.getWindow() != null) {
            loginDialog.getWindow().setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
        }
        loginWebView.loadUrl(url);
        if (automaticCasOnly) {
            handler.postDelayed(() -> {
                if (!completed && automaticCasOnly && loginWebView != null) {
                    rejectAndClose("统一身份认证会话未恢复");
                }
            }, CAS_AUTOMATIC_TIMEOUT_MS);
        }
        if (automaticTheolOnly) {
            handler.postDelayed(() -> {
                if (!completed && automaticTheolOnly && loginWebView != null) {
                    rejectAndClose("课程平台单点会话未恢复");
                }
            }, THEOL_AUTOMATIC_TIMEOUT_MS);
        }
    }

    private final class CasWebViewClient extends WebViewClient {
        private final ProgressBar progress;

        CasWebViewClient(ProgressBar progress) {
            this.progress = progress;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (isTrustedUrl(url)) return false;
            setStatus("已阻止跳转到非校园网地址");
            return true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (isTrustedUrl(url)) return false;
            setStatus("已阻止跳转到非校园网地址");
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (progress != null) progress.setVisibility(View.VISIBLE);
            setStatus("正在加载认证页面…");
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (progress != null) progress.setVisibility(View.GONE);
            // Automatic recovery starts at the portal after the unified-auth
            // endpoint redirects. The portal itself is also used while the
            // existing TGC is being exchanged for a service ticket, so do not
            // reject that intermediate page before its JavaScript runs.
            if (isSuccessfulCampusUrl(url)) {
                if (bootstrapTheolAfterCas && isJwglxtSuccessUrl(url)) {
                    bootstrapTheolAfterCas = false;
                    waitingForTheol = true;
                    autoTheolAttempted = true;
                    setStatus("教务已连接，正在自动连接课程平台…");
                    handler.postDelayed(() -> {
                        if (!completed && loginWebView != null) loginWebView.loadUrl(THEOL_HOME_URL);
                    }, THEOL_BOOTSTRAP_DELAY_MS);
                    return;
                }
                if (waitingForTheol && isJwglxtSuccessUrl(url)) {
                    scheduleTheolRetry();
                    return;
                }
                if (waitingForTheol && isTheolSuccessUrl(url)) {
                    waitingForTheol = false;
                    setStatus("教务和课程平台均已连接");
                    handler.postDelayed(() -> finishIfAuthenticated(url, 0), 350);
                    return;
                }
                setStatus("认证成功，正在建立教务会话…");
                handler.postDelayed(() -> finishIfAuthenticated(url, 0), 350);
            } else if (isLoginUrl(url)) {
                if (waitingForTheol && !theolRequired) {
                    // THEOL's SSO endpoint can briefly look like a login page
                    // before redirecting with the CAS session. Do not expose a
                    // second password prompt; give the hand-off a short window
                    // and then return the already valid academic session.
                    setStatus("教务已连接，正在确认课程平台会话…");
                    scheduleTheolRetry();
                    scheduleTheolFallback(url);
                } else {
                    setStatus("请输入统一身份认证账号和密码");
                }
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                if (waitingForTheol) {
                    setStatus("教务已连接，正在重试课程平台会话…");
                    scheduleTheolRetry();
                } else {
                    setStatus("认证页面加载失败，请检查网络后重试");
                }
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            setStatus("认证页面安全连接失败");
        }

        private void scheduleTheolFallback(String url) {
            if (theolFallbackScheduled) return;
            theolFallbackScheduled = true;
            handler.postDelayed(() -> {
                if (completed || !waitingForTheol) return;
                waitingForTheol = false;
                setStatus("教务已连接，课程平台会话稍后可自动恢复");
                finishIfAuthenticated(url, 0);
            }, THEOL_FALLBACK_DELAY_MS);
        }

        private void scheduleTheolRetry() {
            if (theolRetryScheduled || completed || !waitingForTheol || theolRetryCount >= THEOL_RETRY_LIMIT) return;
            theolRetryScheduled = true;
            handler.postDelayed(() -> {
                theolRetryScheduled = false;
                if (completed || !waitingForTheol || loginWebView == null) return;
                theolRetryCount += 1;
                setStatus("教务已连接，正在自动连接课程平台（" + theolRetryCount + "/" + THEOL_RETRY_LIMIT + "）…");
                loginWebView.loadUrl(THEOL_HOME_URL);
            }, THEOL_RETRY_DELAY_MS);
        }
    }

    private void finishIfAuthenticated(String url, int attempt) {
        if (completed || pendingCall == null || loginWebView == null) return;
        CookieManager.getInstance().flush();
        String jwglxtCookies = academicCookies();
        String theolCookies = theolCookies();
        String cookies = mergeCookieHeaders(jwglxtCookies, theolCookies);
        boolean academicReady = !academicRequired || hasCookie(jwglxtCookies, "JSESSIONID");
        boolean theolReady = !theolRequired || hasCookie(theolCookies, "JSESSIONID");
        if (!academicReady || !theolReady || cookies.trim().isEmpty()) {
            if (attempt < 40) {
                handler.postDelayed(() -> finishIfAuthenticated(url, attempt + 1), 250);
                return;
            }
            setStatus("教务会话尚未建立，请稍候…");
            return;
        }
        completed = true;
        PluginCall call = pendingCall;
        pendingCall = null;
        JSObject result = new JSObject();
        result.put("casCookies", casCookies());
        result.put("cookies", cookies);
        result.put("jwglxtCookies", jwglxtCookies);
        result.put("theolCookies", theolCookies);
        result.put("theolConnected", !theolCookies.trim().isEmpty());
        // CAS is the single user-facing login. A failed automatic THEOL
        // hand-off must never turn into a second password prompt for a CAS
        // session; direct THEOL login keeps its own failure signal.
        result.put("theolAuthRequired", (theolRequired || automaticTheolExpected) && theolCookies.trim().isEmpty());
        result.put("url", url);
        call.resolve(result);
        if (loginDialog != null && loginDialog.isShowing()) loginDialog.dismiss();
    }

    private static String academicCookies() {
        return cookiesForUrls(new String[] {
                JWGLXT_COOKIE_URL,
                "https://jwglxt.buct.edu.cn/jwglxt/",
                "https://jwglxt.buct.edu.cn/sso/"
        });
    }

    private static String casCookies() {
        return cookiesForUrls(new String[] {
                CAS_COOKIE_URL,
                "https://experimental-auth-endpoint.buct.edu.cn/cas/",
                "https://experimental-auth-endpoint.buct.edu.cn/cas/login",
                PORTAL_COOKIE_URL,
                "https://portal.buct.edu.cn/normal/",
                "https://portal.buct.edu.cn/normal/login-mobile.html",
                "https://portal.buct.edu.cn/normal/login-normal.html"
        });
    }

    private static String theolCookies() {
        return cookiesForUrls(new String[] {
                "https://course.buct.edu.cn/",
                "https://course.buct.edu.cn/meol/",
                "https://course.buct.edu.cn/meol/homepage/common/"
        });
    }

    private static String cookiesForUrls(String[] urls) {
        CookieManager manager = CookieManager.getInstance();
        Map<String, String> values = new LinkedHashMap<>();
        for (String url : urls) {
            String raw = manager.getCookie(url);
            if (raw == null) continue;
            for (String part : raw.split(";")) {
                int separator = part.indexOf('=');
                if (separator <= 0) continue;
                String name = part.substring(0, separator).trim();
                String value = part.substring(separator + 1).trim();
                if (!name.isEmpty() && !value.isEmpty()) values.put(name, value);
            }
        }
        return cookieMapToHeader(values);
    }

    private static String cookieMapToHeader(Map<String, String> values) {
        StringBuilder result = new StringBuilder();
        for (Map.Entry<String, String> entry : values.entrySet()) {
            if (entry.getValue() == null || entry.getValue().isEmpty()) continue;
            if (result.length() > 0) result.append("; ");
            result.append(entry.getKey()).append('=').append(entry.getValue());
        }
        return result.toString();
    }

    private static boolean hasCookie(String header, String expectedName) {
        for (String part : String.valueOf(header == null ? "" : header).split(";")) {
            int separator = part.indexOf('=');
            if (separator <= 0) continue;
            String name = part.substring(0, separator).trim();
            String value = part.substring(separator + 1).trim();
            if (expectedName.equalsIgnoreCase(name) && !value.isEmpty()) return true;
        }
        return false;
    }

    private static String mergeCookieHeaders(String... headers) {
        Map<String, String> values = new LinkedHashMap<>();
        for (String header : headers) {
            if (header == null) continue;
            for (String part : header.split(";")) {
                int separator = part.indexOf('=');
                if (separator <= 0) continue;
                String name = part.substring(0, separator).trim();
                String value = part.substring(separator + 1).trim();
                if (!name.isEmpty() && !value.isEmpty()) values.put(name, value);
            }
        }
        return cookieMapToHeader(values);
    }

    private SharedPreferences secureSessionPreferences() {
        Context context = getActivity().getApplicationContext();
        return context.getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey sessionKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (!keyStore.containsAlias(SESSION_KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                    SESSION_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build());
            generator.generateKey();
        }
        return (SecretKey) keyStore.getKey(SESSION_KEY_ALIAS, null);
    }

    private void rejectAndClose(String message) {
        if (pendingCall != null) {
            PluginCall call = pendingCall;
            pendingCall = null;
            completed = true;
            call.reject(message);
        }
        if (loginDialog != null && loginDialog.isShowing()) loginDialog.dismiss();
    }

    private void setStatus(String value) {
        if (statusView != null) statusView.setText(value);
    }

    private void destroyWebView() {
        if (loginWebView == null) return;
        loginWebView.stopLoading();
        loginWebView.setWebChromeClient(null);
        loginWebView.setWebViewClient(null);
        loginWebView.destroy();
        loginWebView = null;
    }

    @Override
    protected void handleOnDestroy() {
        handler.removeCallbacksAndMessages(null);
        completed = true;
        if (pendingCall != null) {
            getBridge().releaseCall(pendingCall);
            pendingCall = null;
        }
        if (loginDialog != null && loginDialog.isShowing()) loginDialog.dismiss();
        destroyWebView();
        loginDialog = null;
        statusView = null;
        super.handleOnDestroy();
    }

    private static boolean isTrustedUrl(String rawUrl) {
        try {
            Uri uri = Uri.parse(rawUrl);
            String scheme = String.valueOf(uri.getScheme()).toLowerCase(Locale.ROOT);
            String host = String.valueOf(uri.getHost()).toLowerCase(Locale.ROOT);
            return "https".equals(scheme) && ("buct.edu.cn".equals(host) || host.endsWith(".buct.edu.cn"));
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isSuccessfulCampusUrl(String rawUrl) {
        try {
            return isJwglxtSuccessUrl(rawUrl) || isTheolSuccessUrl(rawUrl);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isTheolHostUrl(String rawUrl) {
        try {
            return THEOL_HOST.equals(String.valueOf(Uri.parse(rawUrl).getHost()).toLowerCase(Locale.ROOT));
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isJwglxtSuccessUrl(String rawUrl) {
        try {
            Uri uri = Uri.parse(rawUrl);
            String host = String.valueOf(uri.getHost()).toLowerCase(Locale.ROOT);
            String path = String.valueOf(uri.getPath()).toLowerCase(Locale.ROOT);
            if (!JWGLXT_HOST.equals(host) || path.contains("login_slogin")) return false;
            // Zhengfang deployments use more than one post-SSO landing path.
            // The session cookie check in finishIfAuthenticated remains the
            // authority, while this broad host/path match handles callback
            // and index paths that do not have the same final URL.
            return path.contains("/sso/jziotlogin") || path.startsWith("/jwglxt/");
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isTheolSuccessUrl(String rawUrl) {
        try {
            Uri uri = Uri.parse(rawUrl);
            String host = String.valueOf(uri.getHost()).toLowerCase(Locale.ROOT);
            String path = String.valueOf(uri.getPath()).toLowerCase(Locale.ROOT);
            if (!THEOL_HOST.equals(host) || !path.startsWith("/meol/")) return false;
            // Different THEOL deployments finish the same SSO hand-off on
            // personal.do, the student homepage, or a common homepage shell.
            // The login endpoint itself is deliberately excluded because it
            // can be displayed briefly before CAS redirects back.
            return !path.contains("/login") && !path.contains("sso_login");
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isLoginUrl(String rawUrl) {
        try {
            String path = String.valueOf(Uri.parse(rawUrl).getPath()).toLowerCase(Locale.ROOT);
            String host = String.valueOf(Uri.parse(rawUrl).getHost()).toLowerCase(Locale.ROOT);
            return path.contains("/cas/login")
                    || path.contains("login_slogin")
                    || path.contains("/normal/login")
                    || path.contains("/sso_login")
                    || "portal.buct.edu.cn".equals(host);
        } catch (Exception ignored) {
            return false;
        }
    }

    private int dp(int value) {
        return Math.round(value * getActivity().getResources().getDisplayMetrics().density);
    }

    private static void seedCookies(String url, String header, Runnable completion) {
        CookieManager manager = CookieManager.getInstance();
        manager.setAcceptCookie(true);
        List<String> cookies = new ArrayList<>();
        for (String part : String.valueOf(header == null ? "" : header).split(";")) {
            String cookie = part.trim();
            if (cookie.indexOf('=') <= 0) continue;
            cookies.add(cookie);
        }
        seedCookie(manager, url, cookies, 0, completion);
    }

    private static void seedCookie(CookieManager manager, String url, List<String> cookies, int index, Runnable completion) {
        if (index >= cookies.size()) {
            manager.flush();
            completion.run();
            return;
        }
        manager.setCookie(url, cookies.get(index), ignored ->
                seedCookie(manager, url, cookies, index + 1, completion));
    }
}
