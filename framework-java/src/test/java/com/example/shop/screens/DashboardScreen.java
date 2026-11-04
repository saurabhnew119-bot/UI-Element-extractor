package com.example.shop.screens;

import com.elementiq.mobile.screens.BaseScreen;
import java.time.Duration;

public class DashboardScreen extends BaseScreen {

    public boolean isShown() {
        return element("dashboardGreeting").exists(Duration.ofSeconds(15));
    }

    public String greeting() {
        return element("dashboardGreeting").text();
    }

    public LoginScreen logout() {
        element("logoutButton").tap();
        return new LoginScreen();
    }
}
