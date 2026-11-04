package com.example.shop.screens;

import com.elementiq.mobile.screens.BaseScreen;
import java.time.Duration;

/** One login screen for both platforms; locators come from the ElementIQ repository. */
public class LoginScreen extends BaseScreen {

    public boolean isShown() {
        return element("loginButton").exists(Duration.ofSeconds(10));
    }

    public DashboardScreen loginAs(String user, String password) {
        element("username").type(user);
        element("password").type(password);
        actions().hideKeyboard();
        element("loginButton").tap();
        return new DashboardScreen();
    }

    public void openForgotPassword() {
        element("forgotPassword").tap();
    }
}
