/**
 * header.xml 스키마 충실도 — 한컴 정상 출력 스키마 정합(xj3.3).
 *   - head 상위블록: compatibleDocument(HWP201X) / docOption
 *   - charPr 기본 자식: underline/strikeout/outline/shadow 항상 emit(NONE 기본)
 *   - paraPr: autoSpacing + lineSpacing unit
 * 픽스처 불필요(htmlToHwpx 산출 header 검사).
 * [shyang 2026-06-23]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpx } from "../src/lib/hwp/index.js";

async function header(html: string): Promise<string> {
  const zip = await JSZip.loadAsync(await htmlToHwpx(html));
  return await zip.file("Contents/header.xml")!.async("string");
}

describe("header.xml 스키마 충실도 (hwp-convert-xj3.3)", () => {
  it("head 상위블록: compatibleDocument(HWP201X) + docOption", async () => {
    const h = await header(`<p>본문</p>`);
    expect(h).toContain('<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>');
    expect(h).toContain('<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>');
    // refList 뒤·head 닫기 전 위치
    expect(h.indexOf("</hh:refList>")).toBeLessThan(h.indexOf("<hh:compatibleDocument"));
    expect(h.indexOf("<hh:compatibleDocument")).toBeLessThan(h.indexOf("</hh:head>"));
    // trackchageConfig 는 flags 가변이라 미emit
    expect(h).not.toContain("trackchageConfig");
  });

  it("charPr 기본 자식: outline/shadow 항상, underline/strikeout NONE 기본", async () => {
    const h = await header(`<p>일반 텍스트</p>`);
    expect(h).toContain('<hh:outline type="NONE"/>');
    expect(h).toContain('<hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/>');
    expect(h).toMatch(/<hh:underline type="NONE"/); // 밑줄 없는 글자도 NONE 으로 항상 emit
    expect(h).toMatch(/<hh:strikeout shape="NONE"/);
  });

  it("paraPr: autoSpacing + lineSpacing unit", async () => {
    const h = await header(`<p>본문</p>`);
    expect(h).toContain('<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>');
    expect(h).toMatch(/<hh:lineSpacing type="PERCENT" value="\d+" unit="HWPUNIT"\/>/);
  });

  it("memoProperties: 섹션 수만큼 memoPr (HTML 단일 섹션 → itemCnt 1)", async () => {
    const h = await header(`<p>본문</p>`);
    expect(h).toMatch(/<hh:memoProperties itemCnt="1">/);
    expect(h).toContain('<hh:memoPr id="1"');
  });
});
