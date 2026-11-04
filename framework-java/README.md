# ElementIQ Mobile Framework (Java)

A test framework where **one test runs on both Android and iOS**. Screens are written once against logical element names. Each platform's locators come from the ElementIQ repository, and the few behaviours that really differ (back, keyboard, swipes, permission dialogs) live behind one interface.

Stack: Java 17+, Appium java-client 10.1.1 (Selenium 4.42.0 pinned), TestNG 7.10, Cucumber 7.20, and a Maven wrapper (no global Maven needed).

## How it fits together

```
login.feature / LoginTest            ← written once
        │
  LoginScreen extends BaseScreen      ← element("loginButton").tap()
        │
  ElementIQ repository.json           ← loginButton: android id=…:id/login_button
        │                                            ios accessibility id=loginButton
  UiAutomator2 (Android) | XCUITest (iOS)   ← chosen by -Dplatform
```

- **No `if (android)` in tests.** Use `PlatformActions` (`AndroidActions` / `IosActions`) for gestures. Use `byPlatform(...)` in a screen only for a genuinely different flow.
- **Never borrows across platforms.** If an element has no iOS locator, the run fails with "has no ios locators… record it on an ios device".
- **Runtime healing.** When the primary locator fails, the recorded alternatives are tried. Every fallback is written to `target/elementiq/healing-report.json`, and a test never silently passes on a guess that wasn't recorded.
- **Failure artifacts.** Screenshot and `page-source.xml` go to `target/elementiq/artifacts/<platform>/<test>/`, and the page source loads straight into the ElementIQ inspector.

## Run

```powershell
.\mvnw.cmd test                                    # framework self-tests (no device needed)
.\mvnw.cmd test -Pmobile -Dplatform=android -Dudid=emulator-5554
.\mvnw.cmd test -Pmobile -Dplatform=ios -Dudid=<UDID> -Dappium.url=http://<mac>:4723
.\mvnw.cmd test -Pmobile -Dplatform=ios "-Dcucumber.filter.tags=@smoke"
```

(`./mvnw` on macOS/Linux.) Settings live in `src/test/resources/elementiq/android.properties` and `ios.properties`, and any key can be overridden with `-Dkey=value`.

| Key | Meaning |
|---|---|
| `appium.url`, `udid`, `deviceName`, `platformVersion` | Device/server |
| `appId` | Android **package** or iOS **bundle id** (per platform file) |
| `app`, `appActivity`, `device.kind` | Build to install. APK↔IPA mix-ups and `.ipa` on a simulator are rejected. |
| `wda.xcodeOrgId`, `wda.xcodeSigningId`, `wda.updatedBundleId`, `wda.usePrebuilt`, `wda.url` | WebDriverAgent signing for physical iPhones |
| `timeout.seconds`, `healing.enabled`, `elementiq.repository`, `healing.report`, `artifacts.dir` | Behaviour |

## Write tests

```java
public class LoginScreen extends BaseScreen {
    public DashboardScreen loginAs(String user, String pass) {
        element("username").type(user);
        element("password").type(pass);
        actions().hideKeyboard();          // Android: hideKeyboard; iOS: Done/Return
        element("loginButton").tap();
        return new DashboardScreen();
    }
}

public class LoginTest extends BaseMobileTest {            // session per test, artifacts on failure
    @Test public void validUserReachesDashboard() { ... }
    @Test @PlatformOnly(Platform.ANDROID) public void systemBackReturnsToLogin() { ... }
}
```

For Cucumber, feature files are shared by both platforms. Tag one-platform scenarios with `@android-only` or `@ios-only`; `MobileCucumberRunner` filters them automatically. Add `com.elementiq.mobile.cucumber` to the glue to get the session hooks (see `com.example.shop.CucumberTest`).

## Maintain locators with ElementIQ

1. **Record:** run the inspector against this repository, e.g. `ELEMENTIQ_DATA=framework-java/src/test/resources/elementiq npm start`. Then, on each platform's device, select the element and use **Save to repository** under the same logical name.
2. **Guard in CI:** `RepositoryContractTest` fails if any `element("…")` used by a screen lacks a unique locator on either platform. No device is needed.
3. **Adopt runtime healing:** after a device run, apply the fallbacks that worked:
   `node src/cli.ts apply-healing --report framework-java/target/elementiq/healing-report.json --data framework-java/src/test/resources/elementiq`
4. **Repair broken elements:** load the failure's `page-source.xml` (or a live session) in the inspector and run a repair. This needs `.elementiq/config.json` in this folder:
   ```json
   { "repositoryDir": "src/test/resources/elementiq",
     "testCommand": { "android": "mvnw.cmd test -Pmobile -Dplatform=android -Dudid=…",
                      "ios": "mvnw.cmd test -Pmobile -Dplatform=ios -Dudid=…" } }
   ```
   ElementIQ updates only that platform's binding in `repository.json`, compiles, runs the affected tests, and keeps a diff with rollback.

## Status

- Verified on this machine: compile, 21 framework self-tests (locator mapping, platform isolation, healing and its report, capability building including WDA signing, wrong-binary rejection, Cucumber tag filtering, and the screen↔repository contract), plus 5 ElementIQ integration tests (repository-mode repair on Android and iOS, auto-rollback, fallback promotion).
- **Not verified:** a run on a real device. With no device, `-Pmobile -Dplatform=ios` fails fast against the local Appium server with "Could not find a driver for automationName 'XCuiTest'" and the XCUITest install hint. Real runs need an Android emulator/device with `ANDROID_HOME` set, and a Mac running Appium + XCUITest for iOS.
