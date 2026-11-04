package com.elementiq.mobile.locators;

import com.elementiq.mobile.config.Platform;
import java.util.List;

/** Ordered locators for one logical element on one platform: the first is primary, the rest are healing fallbacks. */
public record LocatorSet(String element, Platform platform, List<Locator> locators) {

    public LocatorSet {
        if (locators.isEmpty()) {
            throw new IllegalArgumentException("A locator set needs at least one locator");
        }
        locators = List.copyOf(locators);
    }

    public Locator primary() {
        return locators.get(0);
    }

    public static LocatorSet of(String element, Platform platform, Locator... locators) {
        return new LocatorSet(element, platform, List.of(locators));
    }
}
