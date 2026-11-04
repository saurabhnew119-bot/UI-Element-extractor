package com.elementiq.mobile.cucumber;

import com.elementiq.mobile.config.Platform;
import io.cucumber.testng.AbstractTestNGCucumberTests;

/**
 * Base runner that filters out scenarios tagged for the other platform ({@code @android-only} / {@code @ios-only}),
 * combined with any {@code -Dcucumber.filter.tags} given on the command line. Extend it with your
 * {@code @CucumberOptions(features = ..., glue = {"com.elementiq.mobile.cucumber", "your.steps"})}.
 */
public abstract class MobileCucumberRunner extends AbstractTestNGCucumberTests {

    static {
        System.setProperty("cucumber.filter.tags", platformTagFilter(Platform.fromEnvironment(), System.getProperty("cucumber.filter.tags")));
    }

    public static String platformTagFilter(Platform platform, String existing) {
        String exclude = platform == Platform.ANDROID ? "not @ios-only" : "not @android-only";
        return existing == null || existing.isBlank() ? exclude : "(" + existing + ") and " + exclude;
    }
}
