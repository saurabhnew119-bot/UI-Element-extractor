package com.elementiq.mobile.locators;

import com.elementiq.mobile.MobileFrameworkException;
import com.elementiq.mobile.config.Platform;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Reads locators from an ElementIQ repository ({@code repository.json} or an exported bundle). Each logical element
 * keeps separate Android and iOS bindings; a missing binding is an error and is never filled from the other platform.
 */
public final class LocatorRepository {

    private static final Map<String, LocatorRepository> CACHE = new ConcurrentHashMap<>();

    private final String source;
    private final Map<String, JsonNode> elements = new HashMap<>();

    LocatorRepository(String source, JsonNode root) {
        this.source = source;
        if (!"elementiq-repository".equals(root.path("format").asText())) {
            throw new MobileFrameworkException(source + " is not an ElementIQ repository (format must be \"elementiq-repository\").");
        }
        if (root.path("schemaVersion").asInt() != 1) {
            throw new MobileFrameworkException(source + " has unsupported schemaVersion " + root.path("schemaVersion").asText() + "; expected 1.");
        }
        for (JsonNode el : root.path("elements")) {
            elements.put(el.path("name").asText(), el);
        }
    }

    /** Loads from a file path if it exists, otherwise from the classpath. Instances are cached per source. */
    public static LocatorRepository load(String source) {
        return CACHE.computeIfAbsent(source, LocatorRepository::read);
    }

    public static LocatorRepository fromJson(String source, String json) {
        try {
            return new LocatorRepository(source, new ObjectMapper().readTree(json));
        } catch (IOException e) {
            throw new MobileFrameworkException("Invalid repository JSON in " + source, e);
        }
    }

    private static LocatorRepository read(String source) {
        ObjectMapper mapper = new ObjectMapper();
        try {
            Path file = Path.of(source);
            if (Files.isRegularFile(file)) {
                return new LocatorRepository(source, mapper.readTree(file.toFile()));
            }
            try (InputStream in = LocatorRepository.class.getClassLoader().getResourceAsStream(source)) {
                if (in == null) {
                    throw new MobileFrameworkException("ElementIQ repository '" + source + "' not found on disk or classpath.",
                            "Capture elements with the ElementIQ inspector and point elementiq.repository at its repository.json.", null);
                }
                return new LocatorRepository(source, mapper.readTree(in));
            }
        } catch (IOException e) {
            throw new MobileFrameworkException("Cannot read ElementIQ repository " + source, e);
        }
    }

    public boolean has(String element, Platform platform) {
        JsonNode el = elements.get(element);
        return el != null && el.path("platforms").has(platform.key());
    }

    /** Unique locators recorded for the element on this platform, in preference order. */
    public LocatorSet locators(String element, Platform platform) {
        JsonNode el = elements.get(element);
        if (el == null) {
            throw new MobileFrameworkException("Element '" + element + "' is not in the repository " + source + ".",
                    "Record it with the ElementIQ inspector (Save to repository) under this exact name.", null);
        }
        JsonNode binding = el.path("platforms").path(platform.key());
        if (binding.isMissingNode()) {
            throw new MobileFrameworkException("Element '" + element + "' has no " + platform.key() + " locators in " + source + ".",
                    "Record it on a " + platform.key() + " device; locators are never borrowed from the other platform.", null);
        }
        List<Locator> unique = new ArrayList<>();
        for (JsonNode l : binding.path("locators")) {
            if (l.path("unique").asBoolean(false)) {
                unique.add(new Locator(l.path("strategy").asText(), l.path("value").asText()));
            }
        }
        if (unique.isEmpty()) {
            throw new MobileFrameworkException("Element '" + element + "' has no unique " + platform.key() + " locator in " + source + ".",
                    "Ask the app team for an accessibility id/resource-id, then re-record the element.", null);
        }
        return new LocatorSet(element, platform, unique);
    }

    public String source() {
        return source;
    }
}
