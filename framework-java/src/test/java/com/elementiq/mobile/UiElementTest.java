package com.elementiq.mobile;

import static org.testng.Assert.assertEquals;
import static org.testng.Assert.assertFalse;
import static org.testng.Assert.assertNull;
import static org.testng.Assert.assertTrue;
import static org.testng.Assert.expectThrows;

import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.elements.UiElement;
import com.elementiq.mobile.healing.HealingReport;
import com.elementiq.mobile.healing.HealingReport.Outcome;
import com.elementiq.mobile.locators.Locator;
import com.elementiq.mobile.locators.LocatorSet;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.openqa.selenium.By;
import org.openqa.selenium.WebElement;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

public class UiElementTest {

    private static final Locator PRIMARY = new Locator("id", "com.example.shop:id/login_button");
    private static final Locator ALT = new Locator("-android uiautomator", "new UiSelector().className(\"android.widget.Button\").text(\"LOG IN\")");
    private static final LocatorSet SET = LocatorSet.of("loginButton", Platform.ANDROID, PRIMARY, ALT);

    private HealingReport report;
    private final Map<String, List<WebElement>> screen = new HashMap<>();
    private final List<String> clicks = new ArrayList<>();

    @BeforeMethod
    public void reset() {
        report = new HealingReport();
        screen.clear();
        clicks.clear();
    }

    private WebElement fakeElement(String id) {
        return (WebElement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {WebElement.class}, (p, m, a) -> {
            switch (m.getName()) {
                case "click": clicks.add(id); return null;
                case "getText": return "text of " + id;
                case "isDisplayed": return true;
                case "toString": return id;
                default: return null;
            }
        });
    }

    private void show(Locator l, String... ids) {
        List<WebElement> els = new ArrayList<>();
        for (String id : ids) els.add(fakeElement(id));
        screen.put(l.toBy(Platform.ANDROID).toString(), els);
    }

    private UiElement element(boolean healing) {
        return new UiElement(SET, (By by) -> screen.getOrDefault(by.toString(), List.of()), Duration.ZERO, healing, report);
    }

    @Test
    public void usesThePrimaryLocatorWhenItWorks() {
        show(PRIMARY, "btn");
        show(ALT, "btn");
        element(true).tap();
        assertEquals(clicks, List.of("btn"));
        assertTrue(report.entries().isEmpty());
    }

    @Test
    public void healsWithARecordedAlternativeAndReportsIt() {
        show(ALT, "btn");
        element(true).tap();
        element(true).tap();
        assertEquals(clicks, List.of("btn", "btn"));
        assertEquals(report.entries().size(), 1, "repeated lookups are reported once");
        HealingReport.Entry e = report.entries().get(0);
        assertEquals(e.outcome(), Outcome.HEALED);
        assertEquals(e.failedLocator(), PRIMARY);
        assertEquals(e.failedMatches(), 0);
        assertEquals(e.usedLocator(), ALT);
    }

    @Test
    public void skipsAmbiguousLocators() {
        show(PRIMARY, "a", "b");
        show(ALT, "btn");
        element(true).tap();
        assertEquals(clicks, List.of("btn"));
        assertEquals(report.entries().get(0).failedMatches(), 2);
    }

    @Test
    public void doesNotUseAlternativesWhenHealingIsDisabled() {
        show(ALT, "btn");
        MobileFrameworkException e = expectThrows(MobileFrameworkException.class, () -> element(false).tap());
        assertTrue(e.getMessage().contains("id=com.example.shop:id/login_button -> 0 match(es)"), e.getMessage());
        assertFalse(e.getMessage().contains("UiSelector"));
    }

    @Test
    public void explainsWhatWasTriedAndReportsBrokenElements() {
        MobileFrameworkException e = expectThrows(MobileFrameworkException.class, () -> element(true).tap());
        assertTrue(e.getMessage().contains("not found on android"));
        assertTrue(e.getMessage().contains("UiSelector"));
        assertTrue(e.getMessage().contains("ElementIQ"));
        assertEquals(report.entries().get(0).outcome(), Outcome.BROKEN);
        assertNull(report.entries().get(0).usedLocator());
    }

    @Test
    public void negativeChecksDoNotReportBrokenElements() {
        assertFalse(element(true).exists(Duration.ZERO));
        assertFalse(element(true).isDisplayed());
        assertTrue(report.entries().isEmpty());
    }

    @Test
    public void writesAHealingReportForElementIQ() throws Exception {
        show(ALT, "btn");
        report.setCurrentTest("LoginTest.valid");
        element(true).tap();
        Path file = Files.createTempDirectory("eiq").resolve("healing-report.json");
        report.write(file);
        JsonNode json = new ObjectMapper().readTree(file.toFile());
        assertEquals(json.path("format").asText(), "elementiq-healing-report");
        JsonNode entry = json.path("entries").get(0);
        assertEquals(entry.path("element").asText(), "loginButton");
        assertEquals(entry.path("platform").asText(), "android");
        assertEquals(entry.path("usedLocator").path("strategy").asText(), "-android uiautomator");
        assertEquals(entry.path("test").asText(), "LoginTest.valid");
    }
}
