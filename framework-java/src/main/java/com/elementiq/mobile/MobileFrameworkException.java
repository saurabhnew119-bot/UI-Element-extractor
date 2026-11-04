package com.elementiq.mobile;

/** Framework failure with an optional, actionable hint (missing config, signing problems, wrong binary...). */
public class MobileFrameworkException extends RuntimeException {

    private final String hint;

    public MobileFrameworkException(String message) {
        this(message, null, null);
    }

    public MobileFrameworkException(String message, Throwable cause) {
        this(message, null, cause);
    }

    public MobileFrameworkException(String message, String hint, Throwable cause) {
        super(hint == null ? message : message + "\n  hint: " + hint, cause);
        this.hint = hint;
    }

    public String hint() {
        return hint;
    }
}
