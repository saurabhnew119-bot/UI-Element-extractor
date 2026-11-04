package com.elementiq.mobile.healing;

import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.locators.Locator;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Collects locator failures and runtime fallbacks during a run. The JSON file is consumed by
 * {@code elementiq apply-healing}, which promotes working fallbacks in the repository after review.
 */
public final class HealingReport {

    /** What happened when an element was resolved. */
    public enum Outcome {
        /** Primary failed, a recorded alternative matched exactly one element. */
        HEALED,
        /** No recorded locator matched exactly one element. */
        BROKEN
    }

    public record Entry(String element, String platform, Outcome outcome, Locator failedLocator, int failedMatches,
                        Locator usedLocator, String test, String at) {
    }

    private static final HealingReport GLOBAL = new HealingReport();

    private final List<Entry> entries = new ArrayList<>();
    private final ThreadLocal<String> currentTest = new ThreadLocal<>();

    public static HealingReport global() {
        return GLOBAL;
    }

    public void setCurrentTest(String name) {
        currentTest.set(name);
    }

    /** Records an event once per element, platform, outcome and fallback used, so polling does not flood the report. */
    public synchronized void record(String element, Platform platform, Outcome outcome, Locator failed, int failedMatches, Locator used) {
        boolean seen = entries.stream().anyMatch(e -> e.element().equals(element) && e.platform().equals(platform.key())
                && e.outcome() == outcome && java.util.Objects.equals(e.usedLocator(), used));
        if (seen) {
            return;
        }
        entries.add(new Entry(element, platform.key(), outcome, failed, failedMatches, used, currentTest.get(), Instant.now().toString()));
    }

    public synchronized List<Entry> entries() {
        return List.copyOf(entries);
    }

    public synchronized void clear() {
        entries.clear();
    }

    /** Writes the report; does nothing when there is nothing to report. */
    public synchronized void write(Path file) {
        if (entries.isEmpty()) {
            return;
        }
        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("format", "elementiq-healing-report");
        doc.put("version", 1);
        doc.put("generatedAt", Instant.now().toString());
        doc.put("entries", entries);
        try {
            Files.createDirectories(file.toAbsolutePath().getParent());
            new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT).writeValue(file.toFile(), doc);
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot write healing report " + file, e);
        }
    }
}
