package com.elementiq.mobile.actions;

/**
 * Behaviour that genuinely differs between Android and iOS. Screens and steps call this interface and never branch
 * on the platform themselves.
 */
public interface PlatformActions {

    enum Direction { UP, DOWN, LEFT, RIGHT }

    /** Dismisses the on-screen keyboard if it is shown. */
    void hideKeyboard();

    /** Android system back; iOS taps the navigation bar back button. */
    void back();

    /** Swipes across the middle of the screen in the given direction (content moves the other way). */
    void swipe(Direction direction);

    /** Scrolls until an element with this visible text is on screen. */
    void scrollToText(String text);

    /** Accepts a system permission dialog if one is showing; returns whether one was accepted. */
    boolean acceptPermissionIfShown();
}
