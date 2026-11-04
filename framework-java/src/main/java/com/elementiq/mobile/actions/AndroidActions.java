package com.elementiq.mobile.actions;

import io.appium.java_client.AppiumBy;
import io.appium.java_client.android.AndroidDriver;
import java.util.List;
import java.util.Map;
import org.openqa.selenium.Dimension;
import org.openqa.selenium.WebElement;

public final class AndroidActions implements PlatformActions {

    /** Allow buttons of the permission controller across Android versions. */
    private static final List<String> ALLOW_BUTTONS = List.of(
            "com.android.permissioncontroller:id/permission_allow_foreground_only_button",
            "com.android.permissioncontroller:id/permission_allow_button",
            "com.android.packageinstaller:id/permission_allow_button");

    private final AndroidDriver driver;

    public AndroidActions(AndroidDriver driver) {
        this.driver = driver;
    }

    @Override
    public void hideKeyboard() {
        if (driver.isKeyboardShown()) {
            driver.hideKeyboard();
        }
    }

    @Override
    public void back() {
        driver.navigate().back();
    }

    @Override
    public void swipe(Direction direction) {
        Dimension size = driver.manage().window().getSize();
        driver.executeScript("mobile: swipeGesture", Map.of(
                "left", size.width / 10, "top", size.height / 5,
                "width", size.width * 8 / 10, "height", size.height * 3 / 5,
                "direction", direction.name().toLowerCase(), "percent", 0.75));
    }

    @Override
    public void scrollToText(String text) {
        String quoted = "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        driver.findElement(AppiumBy.androidUIAutomator(
                "new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text(" + quoted + "))"));
    }

    @Override
    public boolean acceptPermissionIfShown() {
        for (String id : ALLOW_BUTTONS) {
            List<WebElement> buttons = driver.findElements(AppiumBy.id(id));
            if (!buttons.isEmpty()) {
                buttons.get(0).click();
                return true;
            }
        }
        return false;
    }
}
