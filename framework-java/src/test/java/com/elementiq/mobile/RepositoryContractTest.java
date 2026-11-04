package com.elementiq.mobile;

import static org.testng.Assert.assertTrue;

import com.elementiq.mobile.config.Platform;
import com.elementiq.mobile.locators.LocatorRepository;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;

/**
 * Contract between screens and the repository, checked without a device: every element("...") used by a screen
 * must have a unique locator on every platform its app supports. Copy this test into your project to catch gaps in CI.
 */
public class RepositoryContractTest {

    private static final Pattern ELEMENT_CALL = Pattern.compile("element\\(\"([^\"]+)\"\\)");

    /** One row per app: its screens, its repository, and the platforms it has been recorded on. */
    @DataProvider
    public Object[][] apps() {
        return new Object[][] {
                {"src/test/java/com/example/shop", "elementiq/repository.json", EnumSet.allOf(Platform.class)},
                // mSpace has been recorded on Android only; add Platform.IOS once its iOS locators are captured on a Mac.
                {"src/test/java/com/mli/mspace", "mspace/repository.json", EnumSet.of(Platform.ANDROID)},
        };
    }

    @Test(dataProvider = "apps")
    public void everyScreenElementHasLocatorsOnItsPlatforms(String screens, String repository, Set<Platform> platforms) throws IOException {
        LocatorRepository repo = LocatorRepository.load(repository);
        List<String> problems = new ArrayList<>();
        int checked = 0;
        try (Stream<Path> files = Files.walk(Path.of(screens))) {
            for (Path file : files.filter(f -> f.toString().endsWith("Screen.java")).toList()) {
                Matcher m = ELEMENT_CALL.matcher(Files.readString(file));
                while (m.find()) {
                    for (Platform p : platforms) {
                        checked++;
                        try {
                            repo.locators(m.group(1), p);
                        } catch (MobileFrameworkException e) {
                            problems.add(file.getFileName() + ": " + e.getMessage().lines().findFirst().orElse(""));
                        }
                    }
                }
            }
        }
        assertTrue(checked > 0, "no screen elements found");
        assertTrue(problems.isEmpty(), String.join("\n", problems));
    }
}
