package com.elementiq.mobile.config;

import com.elementiq.mobile.MobileFrameworkException;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Optional;
import java.util.Properties;

/**
 * Run configuration for one platform. Values are layered, later layers winning:
 * <ol>
 *   <li>classpath {@code elementiq/<platform>.properties}</li>
 *   <li>the file named by {@code -Delementiq.config=path} (optional)</li>
 *   <li>JVM system properties with the same keys, e.g. {@code -Dudid=...}</li>
 * </ol>
 */
public final class MobileConfig {

    private final Platform platform;
    private final Properties values;

    public MobileConfig(Platform platform, Properties values) {
        this.platform = platform;
        this.values = values;
    }

    public static MobileConfig load(Platform platform) {
        Properties p = new Properties();
        String resource = "elementiq/" + platform.key() + ".properties";
        try (InputStream in = MobileConfig.class.getClassLoader().getResourceAsStream(resource)) {
            if (in != null) {
                p.load(in);
            }
        } catch (IOException e) {
            throw new MobileFrameworkException("Cannot read " + resource, e);
        }
        String file = System.getProperty("elementiq.config");
        if (file != null && !file.isBlank()) {
            try (Reader r = Files.newBufferedReader(Path.of(file))) {
                p.load(r);
            } catch (IOException e) {
                throw new MobileFrameworkException("Cannot read config file " + file, e);
            }
        }
        for (String key : System.getProperties().stringPropertyNames()) {
            p.setProperty(key, System.getProperty(key));
        }
        return new MobileConfig(platform, p);
    }

    public Platform platform() {
        return platform;
    }

    public Optional<String> get(String key) {
        String v = values.getProperty(key);
        return v == null || v.isBlank() ? Optional.empty() : Optional.of(v.trim());
    }

    public String require(String key) {
        return get(key).orElseThrow(() -> new MobileFrameworkException(
                "Missing configuration '" + key + "' for " + platform.key()
                        + ". Set it in elementiq/" + platform.key() + ".properties or pass -D" + key + "=..."));
    }

    public boolean flag(String key, boolean fallback) {
        return get(key).map(Boolean::parseBoolean).orElse(fallback);
    }

    public String appiumUrl() {
        return get("appium.url").orElse("http://127.0.0.1:4723");
    }

    public Duration timeout() {
        return Duration.ofSeconds(Long.parseLong(get("timeout.seconds").orElse("10")));
    }

    /** Classpath resource or file path of the ElementIQ repository (repository.json or an export bundle). */
    public String repository() {
        return get("elementiq.repository").orElse("elementiq/repository.json");
    }

    public boolean healingEnabled() {
        return flag("healing.enabled", true);
    }

    public Path healingReport() {
        return Path.of(get("healing.report").orElse("target/elementiq/healing-report.json"));
    }

    public Path artifactsDir() {
        return Path.of(get("artifacts.dir").orElse("target/elementiq/artifacts"));
    }
}
