package com.example.shop;

import com.elementiq.mobile.cucumber.MobileCucumberRunner;
import io.cucumber.testng.CucumberOptions;

/** Runs the feature files on the platform given by -Dplatform; @android-only / @ios-only scenarios are filtered. */
@CucumberOptions(
        features = "src/test/resources/features",
        glue = {"com.elementiq.mobile.cucumber", "com.example.shop.steps"},
        plugin = {"pretty", "html:target/cucumber/report.html", "json:target/cucumber/report.json"})
public class CucumberTest extends MobileCucumberRunner {
}
