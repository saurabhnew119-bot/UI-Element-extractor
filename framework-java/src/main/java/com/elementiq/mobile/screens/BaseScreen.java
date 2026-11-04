package com.elementiq.mobile.screens;

import com.elementiq.mobile.actions.PlatformActions;
import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.driver.DriverManager;
import com.elementiq.mobile.driver.MobileSession;
import com.elementiq.mobile.elements.UiElement;
import java.util.function.Supplier;

/**
 * Base for logical screens. A screen is written once for both platforms: it names elements as recorded in the
 * ElementIQ repository and the platform's locators are applied at run time.
 *
 * <pre>
 * public class LoginScreen extends BaseScreen {
 *     public LoginScreen login(String user, String pass) {
 *         element("username").type(user);
 *         element("password").type(pass);
 *         actions().hideKeyboard();
 *         element("loginButton").tap();
 *         return this;
 *     }
 * }
 * </pre>
 */
public abstract class BaseScreen {

    private final MobileSession session;

    protected BaseScreen() {
        this(DriverManager.current());
    }

    protected BaseScreen(MobileSession session) {
        this.session = session;
    }

    protected UiElement element(String logicalName) {
        return session.element(logicalName);
    }

    protected PlatformActions actions() {
        return session.actions();
    }

    protected Platform platform() {
        return session.platform();
    }

    protected MobileSession session() {
        return session;
    }

    /**
     * For the rare flow that differs between platforms (e.g. an extra iOS confirmation sheet). Keep the branches
     * small; anything reusable belongs in {@link PlatformActions}.
     */
    protected <T> T byPlatform(Supplier<T> android, Supplier<T> ios) {
        return platform() == Platform.ANDROID ? android.get() : ios.get();
    }

    protected void byPlatform(Runnable android, Runnable ios) {
        (platform() == Platform.ANDROID ? android : ios).run();
    }
}
