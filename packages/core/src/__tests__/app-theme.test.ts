import { afterEach, describe, expect, it } from "vitest";
import {
  getAppTheme,
  resetAppThemeForTests,
  setAppThemeFromBackground,
  themeFromBackgroundHex,
} from "../app-theme";

afterEach(() => {
  resetAppThemeForTests();
});

describe("themeFromBackgroundHex", () => {
  it("classifies the two Studio grounds on the right side of the midpoint", () => {
    expect(themeFromBackgroundHex("#0e1722")).toBe("dark"); // Studio dark --bg
    expect(themeFromBackgroundHex("#f3f4f6")).toBe("light"); // Studio light --bg
    expect(themeFromBackgroundHex("#ffffff")).toBe("light");
  });

  it("accepts shorthand hex and ignores junk", () => {
    expect(themeFromBackgroundHex("#fff")).toBe("light");
    expect(themeFromBackgroundHex("#000")).toBe("dark");
    expect(themeFromBackgroundHex("not-a-color")).toBeNull();
    expect(themeFromBackgroundHex("#12345")).toBeNull();
  });
});

describe("app theme snapshot", () => {
  it("starts unknown and tracks the last valid background", () => {
    expect(getAppTheme()).toBeNull();
    setAppThemeFromBackground("#f3f4f6");
    expect(getAppTheme()).toBe("light");
    setAppThemeFromBackground("#0e1722");
    expect(getAppTheme()).toBe("dark");
    // Invalid input must not clobber the last known theme.
    setAppThemeFromBackground("garbage");
    expect(getAppTheme()).toBe("dark");
  });
});
