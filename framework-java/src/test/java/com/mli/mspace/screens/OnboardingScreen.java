package com.mli.mspace.screens;

import com.elementiq.mobile.screens.BaseScreen;
import java.time.Duration;

/** Carousel shown on the first launch after install; later launches open straight on {@link LoginScreen}. */
public class OnboardingScreen extends BaseScreen {

    public boolean isShown(Duration wait) {
        return element("loginButton").exists(wait);
    }

    public LoginScreen openLogin() {
        element("loginButton").tap();
        return new LoginScreen();
    }
}
