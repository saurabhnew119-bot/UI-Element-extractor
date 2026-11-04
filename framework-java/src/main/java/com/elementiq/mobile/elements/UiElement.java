package com.elementiq.mobile.elements;

import com.elementiq.mobile.MobileFrameworkException;
import com.elementiq.mobile.healing.HealingReport;
import com.elementiq.mobile.healing.HealingReport.Outcome;
import com.elementiq.mobile.locators.Locator;
import com.elementiq.mobile.locators.LocatorSet;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.openqa.selenium.By;
import org.openqa.selenium.StaleElementReferenceException;
import org.openqa.selenium.WebElement;

/**
 * A logical element resolved through its platform locators. Resolution waits up to the timeout for a locator that
 * matches exactly one element: the primary first, then recorded alternatives (runtime healing, reported).
 */
public class UiElement {

    /** Looks elements up; normally {@code driver::findElements}. */
    @FunctionalInterface
    public interface Finder {
        List<WebElement> find(By by);
    }

    private static final Duration POLL = Duration.ofMillis(250);

    private final LocatorSet locators;
    private final Finder finder;
    private final Duration timeout;
    private final boolean healing;
    private final HealingReport report;

    public UiElement(LocatorSet locators, Finder finder, Duration timeout, boolean healing, HealingReport report) {
        this.locators = locators;
        this.finder = finder;
        this.timeout = timeout;
        this.healing = healing;
        this.report = report;
    }

    public String name() {
        return locators.element();
    }

    public LocatorSet locators() {
        return locators;
    }

    /** Finds the element, waiting up to the configured timeout. */
    public WebElement resolve() {
        return resolve(timeout, true).orElseThrow();
    }

    /**
     * True when the element can be resolved within {@code wait}. Never throws, and a missing element is not
     * reported as broken, so this is safe for "is not shown" checks.
     */
    public boolean exists(Duration wait) {
        return resolve(wait, false).found();
    }

    private Resolution resolve(Duration wait, boolean reportBroken) {
        long deadline = System.nanoTime() + wait.toNanos();
        Map<Locator, Integer> lastCounts = new LinkedHashMap<>();
        List<Locator> candidates = healing ? locators.locators() : List.of(locators.primary());
        while (true) {
            for (int i = 0; i < candidates.size(); i++) {
                Locator l = candidates.get(i);
                List<WebElement> hits = finder.find(l.toBy(locators.platform()));
                lastCounts.put(l, hits.size());
                if (hits.size() == 1) {
                    if (i > 0) {
                        report.record(name(), locators.platform(), Outcome.HEALED, locators.primary(), lastCounts.get(locators.primary()), l);
                    }
                    return new Resolution(hits.get(0), lastCounts);
                }
            }
            if (System.nanoTime() >= deadline) {
                if (reportBroken) report.record(name(), locators.platform(), Outcome.BROKEN, locators.primary(), lastCounts.get(locators.primary()), null);
                return new Resolution(null, lastCounts);
            }
            try {
                Thread.sleep(POLL.toMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new MobileFrameworkException("Interrupted while waiting for " + name(), e);
            }
        }
    }

    private final class Resolution {
        private final WebElement element;
        private final Map<Locator, Integer> counts;

        Resolution(WebElement element, Map<Locator, Integer> counts) {
            this.element = element;
            this.counts = counts;
        }

        boolean found() {
            return element != null;
        }

        WebElement orElseThrow() {
            if (element != null) {
                return element;
            }
            StringBuilder tried = new StringBuilder();
            counts.forEach((l, n) -> tried.append("\n    ").append(l).append(" -> ").append(n).append(" match(es)"));
            throw new MobileFrameworkException("Element '" + name() + "' not found on " + locators.platform().key()
                    + " within " + timeout.toSeconds() + "s. Tried:" + tried,
                    "If the app changed, capture this screen in ElementIQ and run a repair for '" + name() + "'.", null);
        }
    }

    // ---- interactions -----------------------------------------------------------------------------------------

    public UiElement tap() {
        withRetry(WebElement::click);
        return this;
    }

    public UiElement type(String text) {
        withRetry(e -> {
            e.clear();
            e.sendKeys(text);
        });
        return this;
    }

    public UiElement clear() {
        withRetry(WebElement::clear);
        return this;
    }

    public String text() {
        return resolve().getText();
    }

    public String attribute(String name) {
        return resolve().getAttribute(name);
    }

    public boolean isDisplayed() {
        Resolution r = resolve(timeout, false);
        return r.found() && r.element.isDisplayed();
    }

    /** One retry when the screen re-renders between lookup and action. */
    private void withRetry(java.util.function.Consumer<WebElement> action) {
        try {
            action.accept(resolve());
        } catch (StaleElementReferenceException e) {
            action.accept(resolve());
        }
    }
}
