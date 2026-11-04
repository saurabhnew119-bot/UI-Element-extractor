package com.elementiq.mobile.testng;

import com.elementiq.mobile.config.MobileConfig;
import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.driver.DriverManager;
import com.elementiq.mobile.driver.MobileSession;
import com.elementiq.mobile.healing.HealingReport;
import com.elementiq.mobile.support.FailureArtifacts;
import java.lang.reflect.Method;
import org.testng.ITestResult;
import org.testng.SkipException;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.AfterSuite;
import org.testng.annotations.BeforeMethod;

/**
 * Base class for TestNG mobile tests. Starts a session for {@code -Dplatform} before each test and quits it after,
 * saving artifacts on failure. Annotate a test with {@link PlatformOnly} when it applies to one platform.
 */
public abstract class BaseMobileTest {

    @BeforeMethod(alwaysRun = true)
    public void startSession(Method method) {
        Platform platform = Platform.fromEnvironment();
        PlatformOnly only = method.getAnnotation(PlatformOnly.class);
        if (only != null && only.value() != platform) {
            throw new SkipException(method.getName() + " runs on " + only.value().key() + " only.");
        }
        HealingReport.global().setCurrentTest(getClass().getSimpleName() + "." + method.getName());
        DriverManager.start(MobileConfig.load(platform));
    }

    @AfterMethod(alwaysRun = true)
    public void stopSession(ITestResult result) {
        if (!DriverManager.active()) {
            return;
        }
        try {
            if (result.getStatus() == ITestResult.FAILURE) {
                FailureArtifacts.capture(DriverManager.current(), getClass().getSimpleName() + "." + result.getMethod().getMethodName());
            }
        } finally {
            DriverManager.quit();
        }
    }

    @AfterSuite(alwaysRun = true)
    public void writeHealingReport() {
        HealingReport.global().write(MobileConfig.load(Platform.fromEnvironment()).healingReport());
    }

    protected MobileSession session() {
        return DriverManager.current();
    }
}
