package com.elementiq.mobile;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertNotEquals;
import static org.testng.Assert.assertThrows;
import static org.testng.Assert.assertTrue;

import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.locators.Locator;
import com.elementiq.mobile.locators.LocatorRepository;
import com.elementiq.mobile.locators.LocatorSet;
import io.appium.java_client.AppiumBy;
import org.testng.annotations.Test;

public class LocatorTest {

    private final LocatorRepository repo = LocatorRepository.load("elementiq/repository.json");

    @Test
    public void mapsStrategiesToAppiumBy() {
        assertEquals(new Locator("accessibility id", "x").toBy(Platform.IOS), AppiumBy.accessibilityId("x"));
        assertEquals(new Locator("id", "a:id/b").toBy(Platform.ANDROID), AppiumBy.id("a:id/b"));
        assertEquals(new Locator("-ios class chain", "**/XCUIElementTypeButton").toBy(Platform.IOS), AppiumBy.iOSClassChain("**/XCUIElementTypeButton"));
    }

    @Test
    public void refusesPlatformSpecificStrategiesOnTheOtherPlatform() {
        assertThrows(MobileFrameworkException.class, () -> new Locator("-android uiautomator", "new UiSelector()").toBy(Platform.IOS));
        assertThrows(MobileFrameworkException.class, () -> new Locator("-ios predicate string", "label == 'x'").toBy(Platform.ANDROID));
    }

    @Test
    public void readsSeparateBindingsPerPlatform() {
        LocatorSet android = repo.locators("loginButton", Platform.ANDROID);
        LocatorSet ios = repo.locators("loginButton", Platform.IOS);
        assertEquals(android.primary(), new Locator("id", "com.example.shop:id/login_button"));
        assertEquals(ios.primary(), new Locator("accessibility id", "loginButton"));
        assertNotEquals(android.locators(), ios.locators());
        assertTrue(android.locators().size() > 1, "alternatives are kept for runtime healing");
        assertTrue(android.locators().stream().noneMatch(l -> l.strategy().startsWith("-ios")));
        assertTrue(ios.locators().stream().noneMatch(l -> l.strategy().startsWith("-android")));
    }

    @Test
    public void reportsUnknownElementsAndMissingPlatformBindings() {
        MobileFrameworkException e = expectThrows(() -> repo.locators("nope", Platform.ANDROID));
        assertTrue(e.getMessage().contains("not in the repository"));
        LocatorRepository androidOnly = LocatorRepository.fromJson("inline", """
                {"format":"elementiq-repository","schemaVersion":1,"elements":[
                  {"name":"buy","platforms":{"android":{"locators":[{"strategy":"id","value":"buy","unique":true}]}}}]}""");
        assertEquals(androidOnly.locators("buy", Platform.ANDROID).primary().value(), "buy");
        MobileFrameworkException missing = expectThrows(() -> androidOnly.locators("buy", Platform.IOS));
        assertTrue(missing.getMessage().contains("no ios locators"), missing.getMessage());
    }

    @Test
    public void ignoresNonUniqueLocators() {
        LocatorRepository r = LocatorRepository.fromJson("inline", """
                {"format":"elementiq-repository","schemaVersion":1,"elements":[
                  {"name":"icon","platforms":{"android":{"locators":[{"strategy":"id","value":"android:id/icon","unique":false}]}}}]}""");
        assertTrue(expectThrows(() -> r.locators("icon", Platform.ANDROID)).getMessage().contains("no unique android locator"));
    }

    @Test
    public void rejectsFilesThatAreNotRepositories() {
        assertThrows(MobileFrameworkException.class, () -> LocatorRepository.fromJson("x", "{\"elements\":[]}"));
        assertThrows(MobileFrameworkException.class, () -> LocatorRepository.fromJson("x", "{\"format\":\"elementiq-repository\",\"schemaVersion\":2}"));
    }

    private static MobileFrameworkException expectThrows(org.testng.Assert.ThrowingRunnable r) {
        return org.testng.Assert.expectThrows(MobileFrameworkException.class, r);
    }
}
