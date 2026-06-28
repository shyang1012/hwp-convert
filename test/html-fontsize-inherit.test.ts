/**
 * HTML→HWPX — 블록 간 font-size 상속 (hwp-convert-jd0).
 *
 * GIGO: 소스의 의도(조상 font-size)를 충실히 반영. renderNodeChildren 이 노드 자신의 font-size 를
 * 자식(텍스트·블록)에 흘려 (a) 텍스트 크기 CSS 정합 (b) descendant 의 px line-height/letter-spacing
 * 환산 기준이 유효 글자크기가 되게 한다. 자식 자체 font-size 가 우선(override). 헤딩은 자체 크기 유지.
 * [shyang 2026-06-28]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpx } from "../src/lib/hwp/index.js";

async function partsOf(html: string): Promise<{ header: string; section: string }> {
  const zip = await JSZip.loadAsync(await htmlToHwpx(html));
  return {
    header: await zip.file("Contents/header.xml")!.async("string"),
    section: await zip.file("Contents/section0.xml")!.async("string"),
  };
}

/** 특정 텍스트 run 의 charPr height(글자크기 HWPUNIT). */
function charHeightForText(section: string, header: string, text: string): number | null {
  const run = section.match(new RegExp(`<hp:run charPrIDRef="(\\d+)"><hp:t>${text}</hp:t>`));
  if (!run) return null;
  const cp = header.match(new RegExp(`<hh:charPr id="${run[1]}" height="(\\d+)"`));
  return cp ? Number(cp[1]) : null;
}

function paraLineSpacings(header: string): number[] {
  return [...header.matchAll(/<hh:lineSpacing type="PERCENT" value="(\d+)"/g)].map((m) => Number(m[1]));
}
function letterSpacings(header: string): number[] {
  return [...header.matchAll(/<hh:spacing hangul="(-?\d+)"/g)].map((m) => Number(m[1])).filter((n) => n !== 0);
}

describe("블록 간 font-size 상속", () => {
  it("부모 div font-size:20px → 자식 p 텍스트가 20px(height 1500) 상속", async () => {
    const { header, section } = await partsOf(`<div style="font-size:20px"><p>본문</p></div>`);
    expect(charHeightForText(section, header, "본문")).toBe(1500); // 20px*75
  });

  it("자식 자체 font-size 가 조상보다 우선(override)", async () => {
    const { header, section } = await partsOf(
      `<div style="font-size:20px"><p style="font-size:12px">작게</p></div>`
    );
    expect(charHeightForText(section, header, "작게")).toBe(900); // 12px*75, 20px 상속 아님
  });

  it("조부모까지 상속 — div>section>p 체인", async () => {
    const { header, section } = await partsOf(
      `<div style="font-size:24px"><section><p>깊은본문</p></section></div>`
    );
    expect(charHeightForText(section, header, "깊은본문")).toBe(1800); // 24px*75
  });

  it("px line-height 가 블록 상속 font-size 기준 — div 20px > p line-height:24px → 120%", async () => {
    const { header } = await partsOf(`<div style="font-size:20px"><p style="line-height:24px">x</p></div>`);
    expect(paraLineSpacings(header)).toContain(120); // 24/20, 16px 폴백(150)이 아님
    expect(paraLineSpacings(header)).not.toContain(150);
  });

  it("letter-spacing 가 블록 상속 font-size 기준 — div 20px > span letter-spacing:2px → 10%", async () => {
    const { header } = await partsOf(`<div style="font-size:20px"><p><span style="letter-spacing:2px">자간</span></p></div>`);
    expect(letterSpacings(header)).toContain(10); // 2/20, 폴백(13) 아님
    expect(letterSpacings(header)).not.toContain(13);
  });

  it("헤딩은 조상 font-size 에 영향받지 않음(자체 크기 유지)", async () => {
    const { header, section } = await partsOf(`<div style="font-size:40px"><h2>제목</h2></div>`);
    const h = charHeightForText(section, header, "제목");
    expect(h).not.toBe(3000); // 40px*75 상속 아님
    expect(h).toBe(1600); // h2 기본 크기
  });

  it("헤딩 line-height px 는 조상이 아니라 헤딩 크기 기준 환산 (F-01)", async () => {
    // h1=1800(18pt=24px). line-height:24px → 24/24=100%(조상 12px 기준 200% 아님).
    const { header } = await partsOf(`<div style="font-size:12px"><h1 style="line-height:24px">제목</h1></div>`);
    expect(paraLineSpacings(header)).toContain(100);
    expect(paraLineSpacings(header)).not.toContain(200);
  });
});
