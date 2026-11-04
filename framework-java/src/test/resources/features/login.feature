Feature: Login
  The same scenarios run on Android and iOS; each platform uses its own recorded locators.

  Scenario: Valid user reaches the dashboard
    Given the login screen is shown
    When I log in as "demo" with password "demo123"
    Then the dashboard greets the user

  Scenario: User can log out
    Given I am logged in as "demo" with password "demo123"
    When I log out
    Then the login screen is shown

  @android-only
  Scenario: Android back button returns to login
    Given I am logged in as "demo" with password "demo123"
    When I press back
    Then the login screen is shown
