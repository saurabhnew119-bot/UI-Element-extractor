package com.mli.mspace.tests;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertTrue;

import com.elementiq.mobile.testng.BaseMobileTest;
import com.mli.mspace.screens.LoginScreen;
import org.testng.annotations.Test;

/**
 * Login-form checks that need no credentials. Run against the emulator:
 * mvnw.cmd test -Pmobile -Dsuite=src/test/resources/suites/mspace.xml -Dplatform=android
 *     -Delementiq.config=src/test/resources/mspace/android.properties
 *
 * <p>Do not re-enable the disabled tests against this build. On 2026-10-29 the automated runs did not match manual
 * inspection: the empty-form run ended on the signed-in home screen, and the SSO-only run sent a real sign-in
 * ("Invalid Credentials 1 Attempts Remaining" for TEST123). Re-enable only on a test backend with a test account.
 */
public class LoginValidationTest extends BaseMobileTest {

    @Test
    public void loginFormOffersHelpLinks() {
        LoginScreen login = LoginScreen.open();
        assertTrue(login.helpLinksShown(), "'Forgot password?' and 'Not an advisor/employee?' should be shown");
    }

    // Disabled 2026-10-29: on the emulator run this ended on the signed-in home screen. See the class comment.
    @Test(enabled = false)
    public void emptyLoginShowsBothValidationErrors() {
        LoginScreen login = LoginScreen.open().submitExpectingErrors();
        assertEquals(login.ssoIdError(), "Please enter SSO ID");
        assertEquals(login.passwordError(), "Please enter Password");
    }

    // Disabled 2026-10-29: on the emulator run this reached the real backend. See the class comment.
    @Test(enabled = false)
    public void passwordIsRequiredWhenOnlySsoIdIsGiven() {
        LoginScreen login = LoginScreen.open().enterSsoId("TEST123").submitExpectingErrors();
        assertEquals(login.passwordError(), "Please enter Password");
        assertFalse(login.hasSsoIdError(), "SSO ID error should clear once an SSO ID is entered");
    }
}
