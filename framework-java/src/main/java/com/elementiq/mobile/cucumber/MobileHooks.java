package com.elementiq.mobile.cucumber;

import com.elementiq.mobile.config.MobileConfig;
import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.driver.DriverManager;
import com.elementiq.mobile.healing.HealingReport;
import com.elementiq.mobile.support.FailureArtifacts;
import io.cucumber.java.After;
import io.cucumber.java.AfterAll;
import io.cucumber.java.Before;
import io.cucumber.java.Scenario;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Cucumber lifecycle for mobile scenarios. Add {@code com.elementiq.mobile.cucumber} to your glue. Platform-specific
 * scenarios are tagged {@code @android-only} or {@code @ios-only}; see {@link MobileCucumberRunner}.
 */
public class MobileHooks {

    @Before(order = 0)
    public void startSession(Scenario scenario) {
        HealingReport.global().setCurrentTest(scenario.getUri() + ":" + scenario.getLine() + " " + scenario.getName());
        DriverManager.start(MobileConfig.load(Platform.fromEnvironment()));
    }

    @After(order = 0)
    public void stopSession(Scenario scenario) {
        if (!DriverManager.active()) {
            return;
        }
        try {
            if (scenario.isFailed()) {
                Path dir = FailureArtifacts.capture(DriverManager.current(), scenario.getName());
                Path png = dir.resolve("screenshot.png");
                if (Files.exists(png)) {
                    scenario.attach(Files.readAllBytes(png), "image/png", "screenshot");
                }
            }
        } catch (java.io.IOException e) {
            System.err.println("[elementiq] could not attach screenshot: " + e.getMessage());
        } finally {
            DriverManager.quit();
        }
    }

    @AfterAll
    public static void writeHealingReport() {
        HealingReport.global().write(MobileConfig.load(Platform.fromEnvironment()).healingReport());
    }
}
