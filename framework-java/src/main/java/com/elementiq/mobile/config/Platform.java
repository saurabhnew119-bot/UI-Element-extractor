package com.elementiq.mobile.config;

import java.util.Locale;

/** Target platform of a run. Selected with -Dplatform=android|ios (or the PLATFORM environment variable). */
public enum Platform {
    ANDROID("android"),
    IOS("ios");

    private final String key;

    Platform(String key) {
        this.key = key;
    }

    /** Lower-case key used in config files and in the ElementIQ repository ("android" / "ios"). */
    public String key() {
        return key;
    }

    public static Platform fromKey(String value) {
        if (value != null) {
            switch (value.trim().toLowerCase(Locale.ROOT)) {
                case "android":
                    return ANDROID;
                case "ios":
                    return IOS;
                default:
                    break;
            }
        }
        throw new IllegalArgumentException("Unknown platform '" + value + "'. Use -Dplatform=android or -Dplatform=ios.");
    }

    public static Platform fromEnvironment() {
        String value = System.getProperty("platform");
        if (value == null || value.isBlank()) {
            value = System.getenv("PLATFORM");
        }
        return fromKey(value == null || value.isBlank() ? "android" : value);
    }
}
