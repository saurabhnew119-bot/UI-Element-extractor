package com.example.shop.tests;

import io.appium.java_client.AppiumDriver;
import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.android.options.UiAutomator2Options;
import io.appium.java_client.ios.IOSDriver;
import io.appium.java_client.ios.options.XCUITestOptions;
import java.net.URL;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeMethod;

public abstract class BaseTest {

    protected AppiumDriver driver;

    @BeforeMethod
    public void startDriver() throws Exception {
        URL server = new URL(System.getProperty("appium.url", "http://127.0.0.1:4723"));
        String udid = System.getProperty("udid", "");
        if ("ios".equalsIgnoreCase(System.getProperty("platform", "android"))) {
            XCUITestOptions options = new XCUITestOptions()
                    .setUdid(udid)
                    .setBundleId(System.getProperty("bundleId", "com.example.shop"))
                    .setNoReset(true);
            driver = new IOSDriver(server, options);
        } else {
            UiAutomator2Options options = new UiAutomator2Options()
                    .setUdid(udid)
                    .setAppPackage(System.getProperty("appPackage", "com.example.shop"))
                    .setNoReset(true);
            driver = new AndroidDriver(server, options);
        }
    }

    @AfterMethod(alwaysRun = true)
    public void stopDriver() {
        if (driver != null) {
            driver.quit();
        }
    }
}
