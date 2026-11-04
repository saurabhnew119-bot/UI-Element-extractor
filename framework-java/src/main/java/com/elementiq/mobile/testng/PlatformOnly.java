package com.elementiq.mobile.testng;

import com.elementiq.mobile.config.Platform;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** Marks a test that only applies to one platform; it is reported as skipped on the other. */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface PlatformOnly {
    Platform value();
}
