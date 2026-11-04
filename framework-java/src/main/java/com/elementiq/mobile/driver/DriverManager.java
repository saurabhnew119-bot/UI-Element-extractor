package com.elementiq.mobile.driver;

import com.elementiq.mobile.MobileFrameworkException;
import com.elementiq.mobile.config.MobileConfig;
import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.locators.LocatorRepository;

/** One session per thread, so TestNG/Cucumber can run on several devices in parallel. */
public final class DriverManager {

    private static final ThreadLocal<MobileSession> SESSION = new ThreadLocal<>();

    private DriverManager() {
    }

    public static MobileSession start() {
        return start(MobileConfig.load(Platform.fromEnvironment()));
    }

    public static MobileSession start(MobileConfig config) {
        if (SESSION.get() != null) {
            throw new MobileFrameworkException("A session is already running on this thread; call DriverManager.quit() first.");
        }
        // Load the repository before starting the driver so a missing/invalid repository fails fast.
        LocatorRepository repository = LocatorRepository.load(config.repository());
        MobileSession session = new MobileSession(DriverFactory.create(config), config, repository);
        SESSION.set(session);
        return session;
    }

    public static MobileSession current() {
        MobileSession s = SESSION.get();
        if (s == null) {
            throw new MobileFrameworkException("No mobile session on this thread. Extend BaseMobileTest or add the ElementIQ Cucumber hooks to your glue.");
        }
        return s;
    }

    public static boolean active() {
        return SESSION.get() != null;
    }

    public static void quit() {
        MobileSession s = SESSION.get();
        SESSION.remove();
        if (s != null) {
            s.driver().quit();
        }
    }
}
