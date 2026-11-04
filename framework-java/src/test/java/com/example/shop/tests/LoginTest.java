package com.example.shop.tests;

import static org.testng.Assert.assertTrue;

import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.testng.BaseMobileTest;
import com.elementiq.mobile.testng.PlatformOnly;
import com.example.shop.screens.DashboardScreen;
import com.example.shop.screens.LoginScreen;
import org.testng.annotations.Test;

/** Runs unchanged on Android and iOS: ./mvnw test -Pmobile -Dplatform=android|ios */
public class LoginTest extends BaseMobileTest {

    @Test
    public void validUserReachesDashboard() {
        LoginScreen login = new LoginScreen();
        assertTrue(login.isShown(), "login screen should be shown");
        DashboardScreen dashboard = login.loginAs("demo", "demo123");
        assertTrue(dashboard.isShown(), "dashboard should be shown after login");
    }

    @Test
    public void userCanLogOut() {
        LoginScreen login = new LoginScreen().loginAs("demo", "demo123").logout();
        assertTrue(login.isShown(), "login screen should be shown after logout");
    }

    @Test
    @PlatformOnly(Platform.ANDROID)
    public void systemBackReturnsToLogin() {
        new LoginScreen().loginAs("demo", "demo123");
        session().actions().back();
        assertTrue(new LoginScreen().isShown(), "back should return to login");
    }
}
