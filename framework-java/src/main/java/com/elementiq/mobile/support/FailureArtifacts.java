package com.elementiq.mobile.support;

import com.elementiq.mobile.driver.MobileSession;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.openqa.selenium.OutputType;

/**
 * Saves the screenshot and page source when a test fails. The page source can be loaded straight into the
 * ElementIQ inspector ("Offline snapshot") to inspect the failure and run a repair.
 */
public final class FailureArtifacts {

    private FailureArtifacts() {
    }

    public static Path capture(MobileSession session, String testName) {
        String safe = testName.replaceAll("[^A-Za-z0-9._-]+", "_");
        Path dir = session.config().artifactsDir().resolve(session.platform().key()).resolve(safe);
        try {
            Files.createDirectories(dir);
            Files.write(dir.resolve("screenshot.png"), session.driver().getScreenshotAs(OutputType.BYTES));
            Files.writeString(dir.resolve("page-source.xml"), session.driver().getPageSource(), StandardCharsets.UTF_8);
        } catch (IOException | RuntimeException e) {
            // Artifacts are best effort: never hide the original test failure.
            System.err.println("[elementiq] could not save failure artifacts for " + testName + ": " + e.getMessage());
        }
        return dir;
    }
}
