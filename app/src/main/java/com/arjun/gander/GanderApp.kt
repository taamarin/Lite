package com.arjun.gander

import android.app.Application
import com.google.android.material.color.DynamicColors
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewOutcomeReceiver
import androidx.webkit.WebViewStartUpConfig
import androidx.webkit.WebViewStartUpResult
import androidx.webkit.WebViewStartupException
import java.util.concurrent.Executor

/**
 * Starting Chromium is about half the cost of opening a document: roughly 1.5 s
 * measured on API 33, split between the WebView constructor blocking the main
 * thread and the boot that follows. None of it depends on which file is being
 * opened, so there is no reason to wait until the viewer asks for a WebView.
 * Kicking it off when the process starts lets it run while the activity inflates.
 */
class GanderApp : Application() {

    override fun onCreate() {
        super.onCreate()
        DynamicColors.applyToActivitiesIfAvailable(this)
        // A throwaway daemon thread rather than a pool: this runs once per process.
        val warmUpThread = Executor { r ->
            Thread(r, "webview-warmup").apply { isDaemon = true }.start()
        }
        // Including the UI-thread half measured slightly better than background-only
        // (604 ms against 620 ms median on a Nothing Phone 2), because it lands while
        // the system is still bringing the activity up rather than once it is running.
        val config = WebViewStartUpConfig.Builder(warmUpThread)
            .setShouldRunUiThreadStartUpTasks(true)
            .build()

        // Best effort. A device whose WebView provider cannot do this just gets
        // the old behaviour, so nothing here is allowed to break app startup.
        runCatching {
            WebViewCompat.startUpWebView(
                this,
                config,
                object : WebViewOutcomeReceiver<WebViewStartUpResult, WebViewStartupException> {
                    override fun onResult(result: WebViewStartUpResult) = Unit
                    override fun onError(error: WebViewStartupException) = Unit
                }
            )
        }
    }
}
