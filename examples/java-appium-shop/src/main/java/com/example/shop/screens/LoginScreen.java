package com.example.shop.screens;

import io.appium.java_client.AppiumDriver;
import io.appium.java_client.pagefactory.AndroidFindBy;
import io.appium.java_client.pagefactory.AppiumFieldDecorator;
import io.appium.java_client.pagefactory.iOSXCUITFindBy;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.PageFactory;

public class LoginScreen {

    @AndroidFindBy(id = "username")
    @iOSXCUITFindBy(accessibility = "usernameField")
    private WebElement username;

    @AndroidFindBy(id = "password")
    @iOSXCUITFindBy(accessibility = "passwordField")
    private WebElement password;

    @AndroidFindBy(id = "com.example.shop:id/login_button")
    @iOSXCUITFindBy(accessibility = "loginButton")
    private WebElement loginButton;

    @AndroidFindBy(accessibility = "forgot_password")
    @iOSXCUITFindBy(iOSNsPredicate = "type == \"XCUIElementTypeButton\" AND label == \"Forgot password?\"")
    private WebElement forgotPassword;

    public LoginScreen(AppiumDriver driver) {
        PageFactory.initElements(new AppiumFieldDecorator(driver), this);
    }

    public void login(String user, String pass) {
        username.sendKeys(user);
        password.sendKeys(pass);
        loginButton.click();
    }

    public boolean isDisplayed() {
        return loginButton.isDisplayed();
    }
}
