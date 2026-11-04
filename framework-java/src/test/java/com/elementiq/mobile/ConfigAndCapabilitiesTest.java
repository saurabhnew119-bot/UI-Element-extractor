package com.elementiq.mobile;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertThrows;
import static org.testng.Assert.assertTrue;

import com.elementiq.mobile.config.MobileConfig;
import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.cucumber.MobileCucumberRunner;
import com.elementiq.mobile.driver.CapabilitiesFactory;
import com.elementiq.mobile.driver.DriverFactory;
import java.util.Map;
import java.util.Properties;
import org.openqa.selenium.Capabilities;
import org.testng.annotations.Test;

public class ConfigAndCapabilitiesTest {

    private static MobileConfig config(Platform p, Map<String, String> values) {
        Properties props = new Properties();
        props.putAll(values);
        return new MobileConfig(p, props);
    }

    @Test
    public void parsesPlatformKeys() {
        assertEquals(Platform.fromKey("iOS"), Platform.IOS);
        assertEquals(Platform.fromKey(" android "), Platform.ANDROID);
        assertThrows(IllegalArgumentException.class, () -> Platform.fromKey("windows"));
    }

    @Test
    public void loadsPerPlatformDefaultsFromTheClasspath() {
        MobileConfig ios = MobileConfig.load(Platform.IOS);
        assertEquals(ios.timeout().toSeconds(), 15);
        assertEquals(ios.get("appId").orElseThrow(), "com.example.shop");
        assertEquals(MobileConfig.load(Platform.ANDROID).timeout().toSeconds(), 10);
    }

    @Test
    public void buildsUiAutomator2Capabilities() {
        Capabilities caps = CapabilitiesFactory.build(config(Platform.ANDROID, Map.of("udid", "emulator-5554", "appId", "com.example.shop")));
        assertEquals(caps.getCapability("platformName").toString().toLowerCase(), "android");
        // Appium matches automation names case-insensitively; java-client spells it "UIAutomator2".
        assertEquals(caps.getCapability("appium:automationName").toString().toLowerCase(), "uiautomator2");
        assertEquals(caps.getCapability("appium:appPackage"), "com.example.shop");
        assertEquals(caps.getCapability("appium:udid"), "emulator-5554");
    }

    @Test
    public void buildsXcuiTestCapabilitiesWithWdaSigning() {
        Capabilities caps = CapabilitiesFactory.build(config(Platform.IOS, Map.of(
                "udid", "00008110-AAA", "appId", "com.example.shop", "wda.xcodeOrgId", "TEAM123", "wda.updatedBundleId", "com.example.wda")));
        assertEquals(caps.getCapability("platformName").toString().toLowerCase(), "ios");
        assertEquals(caps.getCapability("appium:automationName").toString().toLowerCase(), "xcuitest");
        assertEquals(caps.getCapability("appium:bundleId"), "com.example.shop");
        assertEquals(caps.getCapability("appium:xcodeOrgId"), "TEAM123");
        assertEquals(caps.getCapability("appium:xcodeSigningId"), "Apple Development");
        assertEquals(caps.getCapability("appium:updatedWDABundleId"), "com.example.wda");
        assertFalse(caps.asMap().containsKey("appium:appPackage"));
    }

    @Test
    public void freshLaunchColdStartsTheAppOnBothPlatforms() {
        for (Platform p : Platform.values()) {
            Capabilities fresh = CapabilitiesFactory.build(config(p, Map.of("appId", "com.mli.mspace", "freshLaunch", "true")));
            assertEquals(fresh.getCapability("appium:forceAppLaunch"), true, p.key());
            assertEquals(fresh.getCapability("appium:shouldTerminateApp"), true, p.key());
            Capabilities plain = CapabilitiesFactory.build(config(p, Map.of("appId", "com.mli.mspace")));
            assertFalse(plain.asMap().containsKey("appium:forceAppLaunch"), p.key());
        }
    }

    @Test
    public void rejectsBuildsForTheWrongPlatform() {
        assertThrows(MobileFrameworkException.class, () -> CapabilitiesFactory.build(config(Platform.IOS, Map.of("app", "C:/builds/shop.apk"))));
        assertThrows(MobileFrameworkException.class, () -> CapabilitiesFactory.build(config(Platform.ANDROID, Map.of("app", "/builds/Shop.ipa"))));
        assertThrows(MobileFrameworkException.class, () -> CapabilitiesFactory.build(config(Platform.IOS, Map.of("app", "/b/Shop.ipa", "device.kind", "simulator"))));
        assertThrows(MobileFrameworkException.class, () -> CapabilitiesFactory.build(config(Platform.ANDROID, Map.of())));
    }

    @Test
    public void givesPlatformSpecificHints() {
        assertTrue(DriverFactory.hintFor(Platform.IOS, "xcodebuild failed with code 65").contains("wda.xcodeOrgId"));
        assertTrue(DriverFactory.hintFor(Platform.IOS, "Developer Mode is disabled").contains("Developer Mode"));
        assertTrue(DriverFactory.hintFor(Platform.ANDROID, "Neither ANDROID_HOME nor ANDROID_SDK_ROOT").contains("ANDROID_HOME"));
    }

    @Test
    public void filtersScenariosTaggedForTheOtherPlatform() {
        assertEquals(MobileCucumberRunner.platformTagFilter(Platform.ANDROID, null), "not @ios-only");
        assertEquals(MobileCucumberRunner.platformTagFilter(Platform.IOS, "@smoke"), "(@smoke) and not @android-only");
    }
}
