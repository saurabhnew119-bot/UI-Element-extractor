package com.mli.mspace.screens;

import com.elementiq.mobile.screens.BaseScreen;
import java.time.Duration;

/** "Login with Axis Max Life ID". Locators come from src/test/resources/mspace/repository.json. */
public class LoginScreen extends BaseScreen {

    /** Reaches the login form from a fresh launch, passing the first-launch onboarding if it is shown. */
    public static LoginScreen open() {
        LoginScreen login = new LoginScreen();
        if (login.isShown(Duration.ofSeconds(20))) {
            return login;
        }
        OnboardingScreen onboarding = new OnboardingScreen();
        if (!onboarding.isShown(Duration.ofSeconds(2))) {
            throw new IllegalStateException("Neither the mSpace login form nor the onboarding screen appeared after launch.");
        }
        return onboarding.openLogin();
    }

    public boolean isShown(Duration wait) {
        return element("username").exists(wait);
    }

    public LoginScreen enterSsoId(String ssoId) {
        element("username").type(ssoId);
        return this;
    }

    public LoginScreen enterPassword(String password) {
        element("password").type(password);
        return this;
    }

    /** Taps Login; only for inputs that keep the user on this screen (validation checks). */
    public LoginScreen submitExpectingErrors() {
        actions().hideKeyboard();
        element("submitLogin").tap();
        return this;
    }

    public String ssoIdError() {
        return element("ssoIdError").text();
    }

    public String passwordError() {
        return element("passwordError").text();
    }

    public boolean hasSsoIdError() {
        return element("ssoIdError").exists(Duration.ofSeconds(2));
    }

    public boolean helpLinksShown() {
        return element("forgotPassword").isDisplayed() && element("notAnAdvisor").isDisplayed();
    }
}
