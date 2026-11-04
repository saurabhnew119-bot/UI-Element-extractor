package com.example.shop.tests;

import com.example.shop.screens.DashboardScreen;
import com.example.shop.screens.LoginScreen;
import org.testng.Assert;
import org.testng.annotations.Test;

public class LoginTest extends BaseTest {

    @Test
    public void validUserReachesDashboard() {
        LoginScreen login = new LoginScreen(driver);
        Assert.assertTrue(login.isDisplayed(), "Login screen should be visible");
        login.login(System.getProperty("user", "demo"), System.getProperty("pass", "demo123"));
        Assert.assertTrue(new DashboardScreen(driver).isDisplayed(), "Dashboard should be visible after login");
    }
}
