import { describe, expect, it, vi } from "vitest";

// The module starts capturing on import, so give it a window to listen on first.
const fakeWindow = new EventTarget();
vi.stubGlobal("window", fakeWindow);
const { setInstallPromptOwner } = await import("./useInstallPrompt");

/** Fires an install offer the way the browser does and reports whether it was held back. */
function offer(): boolean {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  fakeWindow.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("install prompt capture", () => {
  it("leaves the browser's own prompt alone until the role is known", () => {
    expect(offer()).toBe(false);
  });

  it("holds it back for the owner, who has the in-app Install row", () => {
    setInstallPromptOwner(true);
    expect(offer()).toBe(true);
  });

  it("lets it through again for a partner", () => {
    setInstallPromptOwner(true);
    setInstallPromptOwner(false);
    expect(offer()).toBe(false);
  });
});
