import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

const UI_HTML = "file://" + path.resolve(__dirname, "../dist/ui.html");

/** Simulate a `code.ts -> ui.tsx` postMessage, same shape the plugin main thread sends. */
async function sendPluginMessage(page: Page, msg: unknown) {
  await page.evaluate((m) => {
    window.postMessage({ pluginMessage: m }, "*");
  }, msg);
}

/** No element's content should overflow the 380px-wide panel — the app relies on
 *  overflow-x: hidden on .app, so any overflow reads as clipped/cut-off text. */
async function assertNoHorizontalOverflow(page: Page) {
  const overflowing = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
      const cs = getComputedStyle(el);
      // Elements that intentionally clip+ellipsize their own overflow (e.g. .item-name)
      // are expected to have scrollWidth > clientWidth — that's the truncation working.
      const intentionallyTruncated = cs.textOverflow === "ellipsis" && cs.overflow === "hidden";
      if (!intentionallyTruncated && el.scrollWidth > vw + 1) {
        bad.push(`${el.className || el.tagName}: scrollWidth=${el.scrollWidth} > ${vw}`);
      }
    });
    return bad;
  });
  expect(overflowing, `elements overflowing viewport: ${overflowing.join(", ")}`).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.goto(UI_HTML);
});

test("no standalone header — gear lives in its own toolbar row above scope", async ({ page }) => {
  await expect(page.locator(".header")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(0);
  await expect(page.locator(".subtitle")).toHaveCount(0);
  await expect(page.locator(".toolbar button.gear")).toBeVisible();
});

test("gear button opens settings-only view; 닫기 returns to main view", async ({ page }) => {
  await expect(page.locator("section.settings")).toHaveCount(0);
  await expect(page.locator("section.controls")).toBeVisible();

  await page.click("button.gear");
  await expect(page.locator("section.settings")).toBeVisible();
  await expect(page.locator("section.controls")).toHaveCount(0);
  await expect(page.locator("section.list")).toHaveCount(0);
  // gear disappears with the rest of .controls while settings is open
  await expect(page.locator("button.gear")).toHaveCount(0);

  await page.click("text=닫기");
  await expect(page.locator("section.settings")).toHaveCount(0);
  await expect(page.locator("section.controls")).toBeVisible();
  await expect(page.locator("button.gear")).toBeVisible();
});

test("repeated open/close via gear and 닫기 ends in a consistent state", async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await page.click("button.gear");
    await expect(page.locator("section.settings")).toBeVisible();
    await page.click("text=닫기");
    await expect(page.locator("section.settings")).toHaveCount(0);
  }
  await expect(page.locator("section.controls")).toBeVisible();
});

test("long token-source frame name does not overflow settings panel", async ({ page }) => {
  await page.click("button.gear");
  const longName =
    "매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우 긴 프레임 이름 VeryLongFrameNameWithoutSpacesXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  await sendPluginMessage(page, { type: "token-source", kind: "color", name: longName });
  await sendPluginMessage(page, { type: "token-source", kind: "typography", name: longName });
  await expect(page.locator(".tpl-status", { hasText: "현재:" }).first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
});

test("api key set/cleared renders masked status without overflow", async ({ page }) => {
  await page.click("button.gear");
  await sendPluginMessage(page, { type: "api-key", key: "sk-abcdefghijklmnopqrstuvwxyz0123456789" });
  await expect(page.locator(".tpl-status", { hasText: "설정됨" })).toBeVisible();
  await expect(page.locator(".tpl-status", { hasText: "설정됨" })).toHaveText(/sk-ab…6789/);
  await assertNoHorizontalOverflow(page);

  await page.click("text=삭제");
  await sendPluginMessage(page, { type: "api-key", key: null });
  await expect(page.locator(".tpl-status", { hasText: "미설정" })).toBeVisible();
});

test("very long violation message wraps (keep-all) instead of overflowing", async ({ page }) => {
  const longMessage =
    "이것은 매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우 긴 위반 메시지입니다 ExtremelyLongUnbrokenTokenXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  await sendPluginMessage(page, {
    type: "scan-result",
    violations: [
      {
        nodeId: "1:1",
        nodeName: "매우매우매우매우매우매우매우매우매우매우 긴 레이어 이름",
        nodeType: "RECTANGLE",
        type: "color",
        message: longMessage,
        detail: "raw=#ABCDEF",
        fix: { kind: "color", field: "fill", hex: "#ABCDEF" },
      },
    ],
    scannedCount: 1,
    scope: "page",
    catalog: { colorVariables: [], paintStyles: [], textStyles: [] },
    spellingCandidates: [],
    ignoredCount: 0,
  });

  await expect(page.locator(".item-msg")).toBeVisible();
  await assertNoHorizontalOverflow(page);

  const style = await page.locator(".item-msg").evaluate((el) => getComputedStyle(el).wordBreak);
  expect(style).toBe("keep-all");
});

test("error state surfaces without breaking layout", async ({ page }) => {
  await sendPluginMessage(page, {
    type: "error",
    message:
      "매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우매우 긴 에러 메시지입니다.",
  });
  await expect(page.locator(".error")).toBeVisible();
  await assertNoHorizontalOverflow(page);
});

test("large violation list (50 items) scrolls vertically without horizontal overflow", async ({ page }) => {
  const violations = Array.from({ length: 50 }, (_, i) => ({
    nodeId: `1:${i}`,
    nodeName: `Layer ${i}`,
    nodeType: "TEXT",
    type: "typography" as const,
    message: `타이포 위반 ${i}`,
    detail: `raw="Inter Regular · ${12 + i}px"`,
    fix: { kind: "typography" as const, summary: `Inter Regular · ${12 + i}px`, family: "Inter", style: "Regular", size: 12 + i },
  }));

  await sendPluginMessage(page, {
    type: "scan-result",
    violations,
    scannedCount: 50,
    scope: "page",
    catalog: { colorVariables: [], paintStyles: [], textStyles: [] },
    spellingCandidates: [],
    ignoredCount: 0,
  });

  await expect(page.locator(".item-wrap")).toHaveCount(50);
  await assertNoHorizontalOverflow(page);
});

test("narrowest supported width (320px, Figma's min resize) has no horizontal overflow in settings or list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 560 });
  await page.click("button.gear");
  await sendPluginMessage(page, { type: "token-source", kind: "color", name: "Some Frame / Nested / Deep Path Name" });
  await assertNoHorizontalOverflow(page);

  await page.click("text=닫기");
  await sendPluginMessage(page, {
    type: "scan-result",
    violations: [
      {
        nodeId: "1:1",
        nodeName: "A very long single unbroken layer name XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        nodeType: "RECTANGLE",
        type: "color",
        message: "색상 위반",
        fix: { kind: "color", field: "fill", hex: "#000000" },
      },
    ],
    scannedCount: 1,
    scope: "page",
    catalog: { colorVariables: [], paintStyles: [], textStyles: [] },
    spellingCandidates: [],
    ignoredCount: 0,
  });
  await assertNoHorizontalOverflow(page);
});

test("empty violations list (0 found) still renders summary without crashing", async ({ page }) => {
  await sendPluginMessage(page, {
    type: "scan-result",
    violations: [],
    scannedCount: 0,
    scope: "page",
    catalog: { colorVariables: [], paintStyles: [], textStyles: [] },
    spellingCandidates: [],
    ignoredCount: 0,
  });
  await assertNoHorizontalOverflow(page);
  const errors = await page.evaluate(() => (window as unknown as { __consoleErrors?: string[] }).__consoleErrors);
  expect(errors ?? []).toEqual([]);
});
