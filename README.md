# ElementIQ Inspector

A cross-platform mobile automation inspector and self-healing tool. Android and iOS are both first-class:

- **One inspector UI** with an Android/iOS selector, independent per-device sessions (simultaneous sessions supported), live screenshots with element highlighting, expandable hierarchy, properties, ranked locator alternatives, interaction recording and playback.
- **Platform-specific drivers**: Appium 2/3 with **UiAutomator2** (Android) and **XCUITest/WebDriverAgent** (iOS), including WebView/WKWebView context switching.
- **Platform-specific locator generation** with uniqueness validation against the captured hierarchy and, for live sessions, against the device.
- **Shared logical element repository**: one business element, with separate Android and iOS bindings, history, screenshots, code references and logical tests. Exportable and re-importable.
- **Existing-project integration**: detects Java (Maven/Gradle, TestNG/JUnit, Appium java-client, Selenium), TypeScript/JavaScript (WebdriverIO/Appium/Playwright) and Python (Appium-Python-Client/pytest). It finds page/screen-object locators and maps them to repository elements.
- **Audited automatic repair**: re-identifies the changed element and patches only the affected platform's code. It then compiles, runs the affected tests, stores the diff and the results, and supports rollback.

Runtime has no dependencies. It needs Node ≥ 23.6 (TypeScript runs through Node's built-in type stripping).

## Quick start

```bash
npm install            # dev-only: typescript + @types/node for `npm run typecheck`
npm start              # http://127.0.0.1:4780  (binds to localhost only: it can edit code and run builds)
node src/cli.ts doctor # check Appium, drivers, adb, Xcode, build tools
npm test               # 60 tests
npm run demo:repair    # Android + iOS repair on a copy of examples/java-appium-shop
```

Environment: `APPIUM_URL` (default `http://127.0.0.1:4723`), `ELEMENTIQ_DATA` (repository dir, default `./.elementiq/data`), `PORT`, `HOST`.

### Android prerequisites
`appium driver install uiautomator2`, Android SDK platform-tools with `ANDROID_HOME` set **for the Appium process**, and USB debugging authorized on the device (or an emulator).

### iOS prerequisites
iOS automation needs **macOS + Xcode** on the machine that runs Appium (`appium driver install xcuitest`). The inspector itself can run anywhere and point at a remote Mac's Appium URL. For physical iPhones:
- The device is paired/trusted with the Mac, and **Developer Mode** is enabled (iOS 16+).
- WebDriverAgent must be signable: provide Team ID (`xcodeOrgId`), signing identity (default `Apple Development`), and a bundle id your team can provision (`updatedWDABundleId`). Alternatively, use a prebuilt WDA or an existing `webDriverAgentUrl`.
- After the first install, trust the developer certificate on the device (Settings › General › VPN & Device Management).
- `.ipa` builds are for devices only. Simulators need a simulator `.app` build. APKs are never accepted for iOS, and IPAs never for Android.

Each of these failure modes is classified into its own error code with a fix hint: `IOS_SIGNING_FAILED`, `IOS_PROVISIONING_PROFILE`, `IOS_DEVICE_NOT_TRUSTED`, `IOS_DEVELOPER_MODE_DISABLED`, `IOS_WDA_FAILED`, `XCODE_NOT_FOUND`, `IOS_REQUIRES_MACOS`, `ANDROID_SDK_MISSING`, `ANDROID_DEVICE_UNAUTHORIZED`, `ANDROID_INSTALL_FAILED`, `DRIVER_NOT_INSTALLED`, `APPIUM_UNREACHABLE`, `WRONG_PLATFORM_BINARY`, and others. The inspector never returns empty or invented inspection results in place of an error.

## Cross-platform test framework

[framework-java/](framework-java/README.md) is a Java + Appium + TestNG + Cucumber framework built on this repository. Tests and feature files are written once against logical element names, and `-Dplatform=android|ios` picks each platform's recorded locators. Runtime healing reports feed `elementiq apply-healing`. Setting `repositoryDir` in a project's `.elementiq/config.json` makes repairs update that project's `repository.json` (with build, tests, diff and rollback) instead of source code.

## Locator preferences

| Rank | Android | iOS |
|---|---|---|
| 1 | `accessibility id` (content-desc) | `accessibility id` from an **accessibilityIdentifier** (name ≠ label) |
| 2 | `id` (resource-id) | `accessibility id` where name = label (warned: follows visible copy/localization) |
| 3 | UiAutomator selectors (resource-id/description + class) | predicate: type + label |
| 4 | UiAutomator class + text (warned: localizable) | class chain: type + name/label |
| 5 | XPath (attribute, then absolute) | predicate on value, class name |
| 6 | — | XPath (attribute, then absolute) |

Every candidate records its match count. Non-unique candidates are kept as evidence but demoted. An Android resource id is never treated as an iOS identifier.

## Repair pipeline

`POST /api/repair`, the **Repairs** tab, or `elementiq repair --root DIR --platform P --element NAME --source page.xml`:

1. Uses the current hierarchy for the **session's platform** only. A hierarchy from the other platform is rejected.
2. Ranks every node against the recorded fingerprint (platform-specific weights over ids, labels, type, bounds, ancestry). It edits code only when the best match scores ≥ 0.6 **and** leads the runner-up by ≥ 0.08. Otherwise the status is `ambiguous` and it shows the candidates.
3. Scans the project and finds code references whose locator matches this element's recorded locators **on this platform** (or shared ones). It then evaluates each reference: `ok`, `missing`, `ambiguous`, `wrong-element`, or `unevaluable` offline (in which case a live session's device count is used).
4. Picks a unique replacement. It keeps the code's existing strategy and short-id style where possible, otherwise uses the platform preference order, restricted to what the code's syntax can express.
5. Patches only the locator expression in `@AndroidFindBy` / `@iOSXCUITFindBy` / `AppiumBy.*` / WDIO `$()` / Python `(AppiumBy.X, "…")`, adding an `AppiumBy` import if needed. **Shared references are blocked by default**, because changing them to one platform's new value could break the other. With `allowSharedEdits`, both platforms are validated.
6. Runs the build/type-check (`mvn test-compile`, `gradle testClasses`, `tsc --noEmit`, `py_compile`, or the configured `buildCommand`).
7. Runs the tests that reference the changed page objects, per platform (`-Dplatform=android|ios` by default, or the configured `testCommand`). Results come from exit codes and JUnit XML. Zero executed tests counts as **skipped, not passed**.
8. Writes `.elementiq/repairs/<id>/record.json`, `diff.patch` and file backups into the project, and updates the repository binding.

Statuses: `verified`, `partial` (some broken refs still need manual work), `unverified` (build/tests could not run, e.g. missing Maven or no device), `rolled-back` (automatic on build/test failure, or on request), `dry-run`, `not-broken`, `ambiguous`, `blocked`, `no-code-refs`. Rollback refuses to overwrite files edited after the repair unless forced.

Optional per-project config, in `.elementiq/config.json` or `elementiq.config.json`:

```json
{
  "buildCommand": "mvn -q -DskipTests test-compile",
  "testCommand": {
    "android": "mvn test -Dtest={tests} -Dplatform=android -Dudid=emulator-5554",
    "ios": "mvn test -Dtest={tests} -Dplatform=ios -Dudid=00008110-XXXX"
  },
  "rollbackOnFailure": true,
  "timeoutMinutes": 30
}
```

## Layout

```
src/core/         types, errors, XML→hierarchy, locator generation, WebDriver client, sessions, repository
src/platforms/    android.ts (adb, UiAutomator2), ios.ts (simctl/devicectl, XCUITest/WDA)
src/integration/  project detection, locator scanning & mapping, build/test runner
src/repair/       matcher (fingerprint similarity), rewrite (syntax-preserving edits), healer (pipeline + audit)
src/server.ts     HTTP API + UI host      src/cli.ts   CLI
ui/               inspector web UI
examples/         java-appium-shop: Java + Appium java-client + TestNG + Maven page objects for both platforms
test/             unit/integration tests; fixtures are captured-style page sources (v1 and a changed v2 per platform)
```

## Acceptance status

The first build (2026-10-27) was on a Windows host with Appium 3.5.2 + UiAutomator2, Java 21, **no Android SDK/adb, no Maven, no macOS, and no devices**. The status below reflects only what was actually run.

| # | Scenario | Status |
|---|---|---|
| 1 | Connect to Android device, inspect app | **Demonstrated on 2026-10-28** on the Android 17 (API 37) emulator `emulator-5554`, via Appium 3.5.2 + UiAutomator2, against the built-in Settings app: discovery, live screenshot/hierarchy (77 nodes), locator live validation (device counts matched snapshot counts), tap/back recording and playback. Not yet done against your own app. |
| 2 | Connect to iPhone/simulator, inspect app | **Not demonstrated**: needs macOS + Xcode + XCUITest. Real Appium returned `DRIVER_NOT_INSTALLED`, and discovery reports `IOS_REQUIRES_MACOS`. |
| 3 | Record elements, attributes, screenshots, platform locators | Verified with captured page sources (UI and API). Live capture is untested on a device. |
| 4 | Export and reload repository | Verified (tests, including screenshot checksum validation). |
| 5 | Map elements to existing Android and iOS code | Verified on `examples/java-appium-shop`. |
| 6 | Simulated Android locator change → Android code repaired | Verified (`npm run demo:repair`, tests). Only the `@AndroidFindBy` line changes. |
| 7 | Simulated iOS locator change → iOS code repaired | Verified. Only the `@iOSXCUITFindBy` line changes. |
| 8 | Execute affected Appium tests, real outcomes | Pipeline verified with real processes (pass → `verified`, fail → automatic rollback). **Real Appium test runs not demonstrated**: Maven and devices were missing, so they were reported as `unverified`/skipped. |
| 9 | Preserve unrelated code, diff, rollback | Verified (exact-content assertions, conflict-safe rollback). |
| 10 | Report missing devices/config errors, never fabricate | Verified against the real host and the real Appium server. |

To finish 1, 2 and 8: run Appium with `ANDROID_HOME` set and a connected device/emulator. Run XCUITest on a Mac with a simulator or a provisioned iPhone. Install Maven (or add `mvnw`), set `udid` in `testCommand`, and repeat the repair against a live session.
