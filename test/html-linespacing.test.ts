/**
 * HTML→HWPX — CSS line-height(행간)·letter-spacing(자간) 명시 반영 (hwp-convert-jd0).
 *
 * 명시값은 반영, 무명시 기본은 통일값(줄간격 160% / 자간 0). PM 결정 2026-06-28.
 *  - line-height → 문단 lineSpacing(paraPr) + lineseg spacing(단일행 지배, hwpx-lineseg-trust).
 *    무단위 1.5→150%, % 150%→150%, px→font-size 기준 환산, normal→기본.
 *  - letter-spacing → 글자 자간 <hh:spacing> percent. px/em→글자크기 기준 %, 무명시→0.
 *  - md/HWP 경로 무회귀(자간 0, 줄간격 각 경로 자체값).
 * [shyang 2026-06-28]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpx, markdownToHwpx } from "../src/lib/hwp/index.js";

async function partsOf(bytes: Uint8Array): Promise<{ header: string; section: string }> {
  const zip = await JSZip.loadAsync(bytes);
  return {
    header: await zip.file("Contents/header.xml")!.async("string"),
    section: await zip.file("Contents/section0.xml")!.async("string"),
  };
}

/** 특정 텍스트 문단의 lineseg vertsize/spacing. */
function linesegForText(section: string, text: string): { vertsize: number; spacing: number } | null {
  for (const p of section.match(/<hp:p\b[\s\S]*?<\/hp:p>/g) ?? []) {
    if (!p.includes(`<hp:t>${text}</hp:t>`)) continue;
    const m = p.match(/<hp:lineseg\b[^>]*vertsize="(\d+)"[^>]*spacing="(\d+)"/);
    if (m) return { vertsize: Number(m[1]), spacing: Number(m[2]) };
  }
  return null;
}

/** header.xml 의 paraPr lineSpacing 값 집합. */
function paraLineSpacings(header: string): number[] {
  return [...header.matchAll(/<hh:lineSpacing type="PERCENT" value="(\d+)"/g)].map((m) => Number(m[1]));
}

/** header.xml 의 charPr 중 <hh:spacing hangul="N"> 의 N(자간) 집합(0 제외). */
function letterSpacings(header: string): number[] {
  return [...header.matchAll(/<hh:spacing hangul="(-?\d+)"/g)].map((m) => Number(m[1])).filter((n) => n !== 0);
}

describe("line-height(행간) 명시 반영", () => {
  it("무단위 line-height:1.5 → paraPr 150% + lineseg spacing = vertsize×0.5", async () => {
    const { header, section } = await partsOf(await htmlToHwpx(`<p style="line-height:1.5">행간</p>`));
    expect(paraLineSpacings(header)).toContain(150);
    const ls = linesegForText(section, "행간")!;
    expect(ls.spacing).toBe(Math.round(ls.vertsize * 0.5)); // 150% → 0.5
  });

  it("퍼센트 line-height:200% → paraPr 200%", async () => {
    const { header } = await partsOf(await htmlToHwpx(`<p style="line-height:200%">x</p>`));
    expect(paraLineSpacings(header)).toContain(200);
  });

  it("px line-height:24px (font-size:16px) → font 기준 환산 150%", async () => {
    // 24/16=1.5 → 150%
    const { header } = await partsOf(await htmlToHwpx(`<p style="font-size:16px; line-height:24px">x</p>`));
    expect(paraLineSpacings(header)).toContain(150);
  });

  it("line-height:normal → 기본 160% 유지(별도 paraShape 미등록)", async () => {
    const { header } = await partsOf(await htmlToHwpx(`<p style="line-height:normal">x</p>`));
    // 150/200 같은 커스텀값이 없어야 함 — 기본 160만.
    expect(paraLineSpacings(header).every((v) => v === 160)).toBe(true);
  });

  it("line-height:0 (비양수) → 무시하고 기본 160% (줄겹침/음수 방지)", async () => {
    const { header } = await partsOf(await htmlToHwpx(`<p style="line-height:0">x</p>`));
    expect(paraLineSpacings(header).every((v) => v === 160)).toBe(true);
  });
});

describe("letter-spacing(자간) 명시 반영", () => {
  it("letter-spacing:2px (font-size:16px) → 자간 약 13% (2/16×100=12.5)", async () => {
    const { header } = await partsOf(
      await htmlToHwpx(`<p><span style="font-size:16px; letter-spacing:2px">자간</span></p>`)
    );
    expect(letterSpacings(header)).toContain(13);
  });

  it("letter-spacing:0.1em → 10% (em=글자크기)", async () => {
    const { header } = await partsOf(await htmlToHwpx(`<p><span style="letter-spacing:0.1em">x</span></p>`));
    expect(letterSpacings(header)).toContain(10);
  });

  it("letter-spacing:normal → 자간 0(커스텀 없음)", async () => {
    const { header } = await partsOf(await htmlToHwpx(`<p><span style="letter-spacing:normal">x</span></p>`));
    expect(letterSpacings(header)).toHaveLength(0);
  });

  it("px 환산이 상속 font-size 반영 — 부모 span font-size:20px → 자식 letter-spacing:2px = 10% (16px 폴백 아님)", async () => {
    const { header } = await partsOf(
      await htmlToHwpx(`<p><span style="font-size:20px"><span style="letter-spacing:2px">자간</span></span></p>`)
    );
    expect(letterSpacings(header)).toContain(10); // 2/20×100=10 (폴백 16px 였으면 13)
    expect(letterSpacings(header)).not.toContain(13);
  });
});

describe("무회귀: md/HWP 경로", () => {
  it("md 문단 줄간격 160% 유지", async () => {
    const { header } = await partsOf(await markdownToHwpx(`안녕`));
    expect(paraLineSpacings(header).every((v) => v === 160)).toBe(true);
  });

  it("md 자간 0(<hh:spacing> 전부 0)", async () => {
    const { header } = await partsOf(await markdownToHwpx(`**굵게** 보통`));
    expect(letterSpacings(header)).toHaveLength(0);
  });
});
