package com.elementiq.mobile.driver;

import com.elementiq.mobile.MobileFrameworkException;
import com.elementiq.mobile.config.MobileConfig;
import com.elementiq.mobile.config.Platform;
import io.appium.java_client.AppiumDriver;
import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.ios.IOSDriver;
import java.net.MalformedURLException;
import java.net.URI;
import java.net.URL;
import org.openqa.selenium.SessionNotCreatedException;
import org.openqa.selenium.WebDriverException;

/** Creates Appium drivers and turns session failures into actionable, platform-specific messages. */
public final class DriverFactory {

    private DriverFactory() {
    }

    public static AppiumDriver create(MobileConfig config) {
        URL server;
        try {
            server = URI.create(config.appiumUrl()).toURL();
        } catch (IllegalArgumentException | MalformedURLException e) {
            throw new MobileFrameworkException("Invalid appium.url: " + config.appiumUrl(), e);
        }
        try {
            return config.platform() == Platform.ANDROID
                    ? new AndroidDriver(server, CapabilitiesFactory.build(config))
                    : new IOSDriver(server, CapabilitiesFactory.build(config));
        } catch (SessionNotCreatedException e) {
            throw new MobileFrameworkException("Could not start " + config.platform().key() + " session: " + firstLine(e.getMessage()),
                    hintFor(config.platform(), e.getMessage()), e);
        } catch (WebDriverException e) {
            throw new MobileFrameworkException("Appium at " + config.appiumUrl() + " failed: " + firstLine(e.getMessage()),
                    "Is Appium running? Start it with `appium` or set -Dappium.url=...", e);
        }
    }

    /** Hints for the failures people hit most often. Mirrors the ElementIQ inspector's classification. */
    public static String hintFor(Platform platform, String message) {
        String m = message == null ? "" : message;
        if (platform == Platform.ANDROID) {
            if (m.contains("ANDROID_HOME") || m.contains("ANDROID_SDK_ROOT")) return "Set ANDROID_HOME for the Appium server process and restart it.";
            if (m.matches("(?s).*INSTALL_(FAILED|PARSE_FAILED)_[A-Z_]+.*")) return "APK install failed: check signature conflicts with an installed build, minSdk and ABI.";
            if (m.toLowerCase().contains("unauthorized")) return "Accept the 'Allow USB debugging' prompt on the device.";
            if (m.contains("Could not find a driver")) return "appium driver install uiautomator2";
            return "Check `adb devices` and the appId/appActivity values.";
        }
        if (m.contains("No profiles for") || m.toLowerCase().contains("provisioning profile")) return "Register the device in your Apple team and set wda.updatedBundleId to a bundle id your team can sign.";
        if (m.contains("Developer Mode")) return "Enable Settings > Privacy & Security > Developer Mode on the iPhone (iOS 16+).";
        if (m.contains("code 65") || m.contains("requires a development team")) return "Set wda.xcodeOrgId (Team ID), wda.xcodeSigningId and wda.updatedBundleId, or use wda.usePrebuilt / wda.url.";
        if (m.contains("not paired") || m.contains("InvalidHostID") || m.toLowerCase().contains("trust")) return "Unlock the device, accept 'Trust This Computer', and trust the developer certificate in Settings > General > VPN & Device Management.";
        if (m.contains("Could not find a driver")) return "Run Appium with the XCUITest driver on a Mac: appium driver install xcuitest";
        return "Check the Xcode log (showXcodeLog is on) on the Appium host.";
    }

    private static String firstLine(String s) {
        return s == null ? "" : s.lines().findFirst().orElse("");
    }
}
