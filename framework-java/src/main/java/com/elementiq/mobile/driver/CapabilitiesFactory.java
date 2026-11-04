package com.elementiq.mobile.driver;

import com.elementiq.mobile.MobileFrameworkException;
import com.elementiq.mobile.config.MobileConfig;
import com.elementiq.mobile.config.Platform;
import io.appium.java_client.android.options.UiAutomator2Options;
import io.appium.java_client.ios.options.XCUITestOptions;
import io.appium.java_client.remote.options.BaseOptions;
import java.time.Duration;
import java.util.Locale;

/**
 * Builds UiAutomator2 or XCUITest options from {@link MobileConfig}. Platform-specific keys are never shared:
 * Android uses appId as the package name, iOS uses it as the bundle identifier.
 */
public final class CapabilitiesFactory {

    private CapabilitiesFactory() {
    }

    public static BaseOptions<?> build(MobileConfig c) {
        c.get("app").ifPresent(app -> checkBinary(c.platform(), app, c.get("device.kind").orElse("")));
        if (c.get("app").isEmpty() && c.get("appId").isEmpty()) {
            throw new MobileFrameworkException("Set either 'app' (build to install) or 'appId' ("
                    + (c.platform() == Platform.ANDROID ? "package name" : "bundle identifier") + ") for " + c.platform().key() + ".");
        }
        return c.platform() == Platform.ANDROID ? android(c) : ios(c);
    }

    private static UiAutomator2Options android(MobileConfig c) {
        UiAutomator2Options o = new UiAutomator2Options()
                .setNewCommandTimeout(Duration.ofMinutes(5))
                .setNoReset(c.flag("noReset", true))
                .setAutoGrantPermissions(c.flag("autoGrantPermissions", true));
        c.get("udid").ifPresent(o::setUdid);
        c.get("deviceName").ifPresent(o::setDeviceName);
        c.get("platformVersion").ifPresent(o::setPlatformVersion);
        c.get("app").ifPresent(o::setApp);
        c.get("appId").ifPresent(o::setAppPackage);
        c.get("appActivity").ifPresent(o::setAppActivity);
        freshLaunch(o, c);
        return o;
    }

    /** {@code freshLaunch=true}: cold-start the app for every session (keeping its data) and stop it afterwards. */
    private static void freshLaunch(BaseOptions<?> o, MobileConfig c) {
        if (c.flag("freshLaunch", false)) {
            o.setCapability("appium:forceAppLaunch", true);
            o.setCapability("appium:shouldTerminateApp", true);
        }
    }

    private static XCUITestOptions ios(MobileConfig c) {
        XCUITestOptions o = new XCUITestOptions()
                .setNewCommandTimeout(Duration.ofMinutes(5))
                .setNoReset(c.flag("noReset", true))
                .setWdaLaunchTimeout(Duration.ofMinutes(4))
                .setShowXcodeLog(true);
        c.get("udid").ifPresent(o::setUdid);
        c.get("deviceName").ifPresent(o::setDeviceName);
        c.get("platformVersion").ifPresent(o::setPlatformVersion);
        c.get("app").ifPresent(o::setApp);
        c.get("appId").ifPresent(o::setBundleId);
        // WebDriverAgent signing for physical devices; simulators ignore these.
        c.get("wda.url").ifPresent(o::setWebDriverAgentUrl);
        if (c.flag("wda.usePrebuilt", false)) {
            o.setUsePrebuiltWda(true);
        }
        c.get("wda.xcodeOrgId").ifPresent(team -> {
            o.amend("appium:xcodeOrgId", team);
            o.amend("appium:xcodeSigningId", c.get("wda.xcodeSigningId").orElse("Apple Development"));
        });
        c.get("wda.updatedBundleId").ifPresent(o::setUpdatedWdaBundleId);
        freshLaunch(o, c);
        return o;
    }

    /** Refuses builds for the other platform, and device builds on simulators. */
    static void checkBinary(Platform platform, String app, String deviceKind) {
        String a = app.toLowerCase(Locale.ROOT).split("\\?")[0];
        if (platform == Platform.ANDROID && (a.endsWith(".ipa") || a.endsWith(".app") || a.endsWith(".app.zip"))) {
            throw new MobileFrameworkException(app + " is an iOS build and cannot be installed on Android.",
                    "Point 'app' in android.properties at the .apk/.aab build.", null);
        }
        if (platform == Platform.IOS && (a.endsWith(".apk") || a.endsWith(".aab"))) {
            throw new MobileFrameworkException(app + " is an Android build and cannot be installed on iOS.",
                    "Point 'app' in ios.properties at the .ipa (device) or .app (simulator) build.", null);
        }
        if (platform == Platform.IOS && "simulator".equalsIgnoreCase(deviceKind) && a.endsWith(".ipa")) {
            throw new MobileFrameworkException(app + " is a device build; simulators need a simulator .app build.", null, null);
        }
    }
}
