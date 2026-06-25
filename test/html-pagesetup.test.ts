/**
 * 4qp — HTML→HWPX 용지 설정 명시 제어 + landscape 시맨틱.
 *
 * 한글 네이티브 모델: 용지 물리치수 고정 + landscape 플래그(WIDELY=세로 / NARROWLY=가로).
 * API 옵션(page: size/orientation/margins)으로 명시 제어, 미지정은 컨테이너 CSS > 기본값 자동.
 * [shyang 2026-06-25]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpDocument } from "../src/lib/hwp/converter.js";
import { htmlToHwpx } from "../src/lib/hwp/index.js";
import { buildSecPr } from "../src/lib/hwp/owpml.js";
import type { HwpPageDef, PageSetupOption } from "../src/lib/hwp/types.js";

const A4_SHORT = 59528;
const A4_LONG = 84186;
const mm = (v: number): number => Math.round((v * 7200) / 25.4);

const BASE_PD: HwpPageDef = {
  width: A4_SHORT,
  height: A4_LONG,
  left: 8504,
  right: 8504,
  top: 5668,
  bottom: 4252,
  header: 4252,
  footer: 4252,
  gutter: 0,
  landscape: false,
};

function pdWith(html: string, page?: PageSetupOption): HwpPageDef | undefined {
  return htmlToHwpDocument(html, page ? { page } : undefined).sections[0].pageDef;
}

describe("4qp: buildSecPr landscape 속성(WIDELY=세로 / NARROWLY=가로)", () => {
  it("무인자 buildSecPr() → WIDELY (기존 출력 불변)", () => {
    expect(buildSecPr()).toMatch(/landscape="WIDELY"/);
  });

  it("pageDef.landscape=false → WIDELY", () => {
    expect(buildSecPr({ ...BASE_PD, landscape: false })).toMatch(/landscape="WIDELY"/);
  });

  it("pageDef.landscape=true → NARROWLY", () => {
    const s = buildSecPr({ ...BASE_PD, landscape: true });
    expect(s).toMatch(/landscape="NARROWLY"/);
    expect(s).not.toMatch(/landscape="WIDELY"/);
  });
});

describe("4qp: 용지 카탈로그 + 커스텀", () => {
  it("size:'A3' → A3 물리치수", () => {
    const pd = pdWith(`<p>x</p>`, { size: "A3" })!;
    expect(pd.width).toBe(84189);
    expect(pd.height).toBe(119055);
  });

  it("size:'Letter' → 8.5×11in", () => {
    const pd = pdWith(`<p>x</p>`, { size: "Letter" })!;
    expect(pd.width).toBe(61200);
    expect(pd.height).toBe(79200);
  });

  it("커스텀 mm 치수 → mm→HWPUNIT 변환", () => {
    const pd = pdWith(`<p>x</p>`, { size: { width: 200, height: 300, unit: "mm" } })!;
    expect(pd.width).toBe(mm(200));
    expect(pd.height).toBe(mm(300));
  });

  it("커스텀 hwpunit 치수 → 그대로", () => {
    const pd = pdWith(`<p>x</p>`, { size: { width: 50000, height: 70000, unit: "hwpunit" } })!;
    expect(pd.width).toBe(50000);
    expect(pd.height).toBe(70000);
  });

  it("알 수 없는 용지명 → 에러", () => {
    expect(() => pdWith(`<p>x</p>`, { size: "B6" as never })).toThrow(/지원하지 않는 용지/);
  });

  it("음수/0 커스텀 치수 → 에러", () => {
    expect(() => pdWith(`<p>x</p>`, { size: { width: 0, height: 300 } })).toThrow(/양수/);
  });
});

describe("4qp: orientation 명시 오버라이드", () => {
  it("orientation:'portrait' + 넓은 본문 → 세로 고정(자동 오버라이드)", () => {
    const pd = pdWith(`<div style="max-width:1200px">넓은 본문</div>`, { orientation: "portrait" })!;
    expect(pd.landscape).toBe(false);
    expect(pd.width).toBe(A4_SHORT);
    expect(pd.height).toBe(A4_LONG);
  });

  it("orientation:'landscape' + 좁은 본문 → 가로 고정(물리치수 세로 유지)", () => {
    const pd = pdWith(`<div style="max-width:300px">좁은 본문</div>`, { orientation: "landscape" })!;
    expect(pd.landscape).toBe(true);
    expect(pd.width).toBe(A4_SHORT); // 스왑 없음
    expect(pd.height).toBe(A4_LONG);
  });

  it("orientation:'auto'(기본) + 넓은 본문 → 가로 전환", () => {
    const pd = pdWith(`<div style="max-width:1200px">본문</div>`)!;
    expect(pd.landscape).toBe(true);
  });

  it("컨테이너 없어도 옵션만으로 pageDef 생성", () => {
    const pd = pdWith(`<p>컨테이너 단서 없음</p>`, { orientation: "landscape" })!;
    expect(pd).toBeDefined();
    expect(pd.landscape).toBe(true);
  });
});

describe("4qp: margins 옵션 우선순위", () => {
  it("margins(mm) 옵션이 컨테이너 padding 보다 우선", () => {
    const pd = pdWith(`<div style="padding:40px">본문</div>`, { margins: { left: 10, right: 20 } })!;
    expect(pd.left).toBe(mm(10)); // 옵션 우선(padding 40px=3000 아님)
    expect(pd.right).toBe(mm(20));
    expect(pd.top).toBe(3000); // 미지정 면은 컨테이너 padding(40px)
  });

  it("일부 필드만 지정 → 나머지는 기본값으로 자동", () => {
    const pd = pdWith(`<p>x</p>`, { margins: { left: 15 } })!;
    expect(pd.left).toBe(mm(15));
    expect(pd.right).toBe(8504); // 한글 기본
    expect(pd.width).toBe(A4_SHORT); // 용지 기본 A4
    expect(pd.landscape).toBe(false); // 방향 기본(auto→본문 없음→세로)
  });
});

describe("4qp: 신호 전무 → 빌더 기본 폴백(undefined)", () => {
  it("옵션·컨테이너 단서 모두 없음 → pageDef undefined", () => {
    expect(pdWith(`<p>그냥 문단</p>`)).toBeUndefined();
    expect(pdWith(`<div>스타일 없음</div>`)).toBeUndefined();
  });
});

describe("4qp: e2e — htmlToHwpx 옵션이 secPr 까지 반영", () => {
  async function pagePrOf(html: string, page?: PageSetupOption): Promise<Record<string, string>> {
    const out = await htmlToHwpx(html, page ? { page } : undefined);
    const zip = await JSZip.loadAsync(out);
    const sec = await zip.file("Contents/section0.xml")!.async("string");
    const pp = sec.match(/<hp:pagePr\b([^>]*)>/)![1];
    const out2: Record<string, string> = {};
    for (const m of pp.matchAll(/(\w+)="([^"]*)"/g)) out2[m[1]] = m[2];
    return out2;
  }

  it("size:'A3' → secPr A3 치수", async () => {
    const pp = await pagePrOf(`<p>본문</p>`, { size: "A3" });
    expect(Number(pp.width)).toBe(84189);
    expect(Number(pp.height)).toBe(119055);
  });

  it("orientation:'portrait' 강제 → secPr WIDELY(세로)", async () => {
    const pp = await pagePrOf(`<div style="max-width:1200px">넓은 본문</div>`, { orientation: "portrait" });
    expect(pp.landscape).toBe("WIDELY");
    expect(Number(pp.width)).toBe(A4_SHORT);
  });
});
