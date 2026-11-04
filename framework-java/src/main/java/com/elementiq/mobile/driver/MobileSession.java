package com.elementiq.mobile.driver;

import com.elementiq.mobile.actions.AndroidActions;
import com.elementiq.mobile.actions.IosActions;
import com.elementiq.mobile.actions.PlatformActions;
import com.elementiq.mobile.config.MobileConfig;
import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.elements.UiElement;
import com.elementiq.mobile.healing.HealingReport;
import com.elementiq.mobile.locators.LocatorRepository;
import io.appium.java_client.AppiumDriver;
import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.ios.IOSDriver;

/** Everything a test needs for one device: driver, config, platform actions and logical elements. */
public final class MobileSession {

    private final AppiumDriver driver;
    private final MobileConfig config;
    private final LocatorRepository repository;
    private final PlatformActions actions;

    public MobileSession(AppiumDriver driver, MobileConfig config, LocatorRepository repository) {
        this.driver = driver;
        this.config = config;
        this.repository = repository;
        this.actions = config.platform() == Platform.ANDROID
                ? new AndroidActions((AndroidDriver) driver)
                : new IosActions((IOSDriver) driver);
    }

    public AppiumDriver driver() {
        return driver;
    }

    public MobileConfig config() {
        return config;
    }

    public Platform platform() {
        return config.platform();
    }

    public PlatformActions actions() {
        return actions;
    }

    public LocatorRepository repository() {
        return repository;
    }

    /** A logical element from the ElementIQ repository, resolved with this platform's locators. */
    public UiElement element(String name) {
        return new UiElement(repository.locators(name, platform()), driver::findElements, config.timeout(),
                config.healingEnabled(), HealingReport.global());
    }
}
