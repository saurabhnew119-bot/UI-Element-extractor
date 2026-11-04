package com.example.shop.steps;

import static org.testng.Assert.assertTrue;

import com.elementiq.mobile.driver.DriverManager;
import com.example.shop.screens.DashboardScreen;
import com.example.shop.screens.LoginScreen;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

/** Step definitions shared by both platforms; they only talk to logical screens. */
public class LoginSteps {

    // Cucumber ignores the keyword when matching, so one annotation serves Given/When/Then.
    @Given("the login screen is shown")
    public void loginScreenIsShown() {
        assertTrue(new LoginScreen().isShown(), "login screen should be shown");
    }

    @When("I log in as {string} with password {string}")
    @Given("I am logged in as {string} with password {string}")
    public void logIn(String user, String password) {
        assertTrue(new LoginScreen().loginAs(user, password).isShown(), "dashboard should be shown after login");
    }

    @Then("the dashboard greets the user")
    public void dashboardGreets() {
        DashboardScreen dashboard = new DashboardScreen();
        assertTrue(dashboard.isShown(), "dashboard should be shown");
        assertTrue(!dashboard.greeting().isBlank(), "greeting should not be empty");
    }

    @When("I log out")
    public void logOut() {
        new DashboardScreen().logout();
    }

    @When("I press back")
    public void pressBack() {
        DriverManager.current().actions().back();
    }
}
