package com.example.shop.screens;

import io.appium.java_client.AppiumBy;
import io.appium.java_client.AppiumDriver;
import org.openqa.selenium.By;

public class DashboardScreen {

    // Shared between platforms: both apps expose the same accessibility id.
    private final By greeting = AppiumBy.accessibilityId("dashboard_greeting");

    private final AppiumDriver driver;

    public DashboardScreen(AppiumDriver driver) {
        this.driver = driver;
    }

    public boolean isDisplayed() {
        return driver.findElement(greeting).isDisplayed();
    }
}
