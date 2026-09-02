import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Explain } from "../src/client/main";

describe("Chinese help tooltip", () => {
  it("keeps the visible label and makes its explanation keyboard reachable", () => {
    const html = renderToStaticMarkup(<Explain description="详细中文说明">模型状态</Explain>);
    expect(html).toContain("模型状态");
    expect(html).toContain("详细中文说明");
    expect(html).toContain("aria-describedby");
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('aria-label="详细中文说明"');
  });
});
