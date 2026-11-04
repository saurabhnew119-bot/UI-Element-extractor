package com.elementiq.mobile.locators;

import com.elementiq.mobile.MobileFrameworkException;
import com.elementiq.mobile.config.Platform;
import io.appium.java_client.AppiumBy;
import org.openqa.selenium.By;

/** One Appium locator, using the same strategy names as the W3C/Appium protocol and the ElementIQ repository. */
public record Locator(String strategy, String value) {

    public By toBy(Platform platform) {
        switch (strategy) {
            case "accessibility id":
                return AppiumBy.accessibilityId(value);
            case "id":
                return AppiumBy.id(value);
            case "xpath":
                return AppiumBy.xpath(value);
            case "class name":
                return AppiumBy.className(value);
            case "-android uiautomator":
                requirePlatform(platform, Platform.ANDROID);
                return AppiumBy.androidUIAutomator(value);
            case "-ios predicate string":
                requirePlatform(platform, Platform.IOS);
                return AppiumBy.iOSNsPredicateString(value);
            case "-ios class chain":
                requirePlatform(platform, Platform.IOS);
                return AppiumBy.iOSClassChain(value);
            default:
                throw new MobileFrameworkException("Unsupported locator strategy '" + strategy + "'.");
        }
    }

    private void requirePlatform(Platform actual, Platform expected) {
        if (actual != expected) {
            throw new MobileFrameworkException("Locator " + this + " is " + expected.key() + "-only and cannot run on " + actual.key() + ".");
        }
    }

    @Override
    public String toString() {
        return strategy + "=" + value;
    }
}
