package com.elementiq.mobile.actions;

import com.elementiq.mobile.MobileFrameworkException;
import io.appium.java_client.AppiumBy;
import io.appium.java_client.ios.IOSDriver;
import java.util.List;
import java.util.Map;
import org.openqa.selenium.NoAlertPresentException;
import org.openqa.selenium.WebElement;

public final class IosActions implements PlatformActions {

    private final IOSDriver driver;

    public IosActions(IOSDriver driver) {
        this.driver = driver;
    }

    @Override
    public void hideKeyboard() {
        if (driver.isKeyboardShown()) {
            // Most iOS keyboards have no dismiss key; XCUITest taps outside or uses the return/Done key.
            driver.executeScript("mobile: hideKeyboard", Map.of("keys", List.of("Done", "Return", "return")));
        }
    }

    @Override
    public void back() {
        // iOS has no system back: use the navigation bar's leading button.
        List<WebElement> buttons = driver.findElements(AppiumBy.iOSClassChain("**/XCUIElementTypeNavigationBar/XCUIElementTypeButton[1]"));
        if (buttons.isEmpty()) {
            throw new MobileFrameworkException("No navigation bar back button on this iOS screen.",
                    "Model the screen's own close/back control in the repository and tap it explicitly.", null);
        }
        buttons.get(0).click();
    }

    @Override
    public void swipe(Direction direction) {
        driver.executeScript("mobile: swipe", Map.of("direction", direction.name().toLowerCase()));
    }

    @Override
    public void scrollToText(String text) {
        String quoted = "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        driver.executeScript("mobile: scroll", Map.of("predicateString", "label == " + quoted, "toVisible", true));
    }

    @Override
    public boolean acceptPermissionIfShown() {
        try {
            driver.switchTo().alert().accept();
            return true;
        } catch (NoAlertPresentException e) {
            return false;
        }
    }
}
