/**
 * wku — HTML <style> 의 @page{size;margin} 직파싱. parseToTree 가 <style> 텍스트를 캡처해
 * @page 규칙을 PageSetupOption 으로 변환, 페이지설정에 반영. 우선순위 API > @page > 컨테이너 > 기본.
 * [shyang 2026-06-27]
 */
import { describe, expect, it } from "vitest";

import { htmlToHwpDocument } from "../src/lib/hwp/converter.js";
import type { HwpPageDef, PageSetupOption } from "../src/lib/hwp/types.js";

const A4_SHORT = 59528; // A4 width(210mm) 카탈로그값
const A4_LONG = 84186; // A4 height(297mm) 카탈로그값
const mm = (v: number): number => Math.round((v * 7200) / 25.4);

function pdOf(html: string, page?: PageSetupOption): HwpPageDef | undefined {
  return htmlToHwpDocument(html, page ? { page } : undefined).sections[0].pageDef;
}

describe("wku: @page size — 방향/용지명/커스텀", () => {
  it("@page{size:A4 landscape} → 가로(landscape), A4 물리치수 고정", () => {
    const pd = pdOf(`<style>@page{size:A4 landscape}</style><p>본문</p>`)!;
    expect(pd.landscape).toBe(true);
    expect(pd.width).toBe(A4_SHORT);
    expect(pd.height).toBe(A4_LONG);
  });

  it("@page{size:landscape} (용지명 생략) → 가로, A4 기본 유지", () => {
    const pd = pdOf(`<style>@page{size:landscape}</style><p>본문</p>`)!;
    expect(pd.landscape).toBe(true);
    expect(pd.width).toBe(A4_SHORT);
  });

  it("@page{size:A3} → A3 물리치수", () => {
    const pd = pdOf(`<style>@page{size:A3}</style><p>본문</p>`)!;
    expect(pd.width).toBe(84189);
    expect(pd.height).toBe(119055);
  });

  it("@page{size:210mm 297mm} 커스텀 → mm 환산 치수", () => {
    const pd = pdOf(`<style>@page{size:210mm 297mm}</style><p>본문</p>`)!;
    expect(pd.width).toBe(mm(210));
    expect(pd.height).toBe(mm(297));
  });

  it("대소문자 무시 — @page{SIZE:a4 LANDSCAPE}", () => {
    const pd = pdOf(`<style>@page { SIZE: a4 LANDSCAPE; }</style><p>본문</p>`)!;
    expect(pd.landscape).toBe(true);
    expect(pd.width).toBe(A4_SHORT);
  });
});

describe("wku: @page margin — 단축/면별/단위", () => {
  it("margin:20mm → 4면 동일", () => {
    const pd = pdOf(`<style>@page{margin:20mm}</style><p>본문</p>`)!;
    expect([pd.left, pd.right, pd.top, pd.bottom]).toEqual([mm(20), mm(20), mm(20), mm(20)]);
  });

  it("margin:10mm 20mm 단축 → 상하=10 / 좌우=20", () => {
    const pd = pdOf(`<style>@page{margin:10mm 20mm}</style><p>본문</p>`)!;
    expect(pd.top).toBe(mm(10));
    expect(pd.bottom).toBe(mm(10));
    expect(pd.left).toBe(mm(20));
    expect(pd.right).toBe(mm(20));
  });

  it("margin-left 면별 지정", () => {
    const pd = pdOf(`<style>@page{margin-left:25mm}</style><p>본문</p>`)!;
    expect(pd.left).toBe(mm(25));
  });

  it("단위 환산 — 2cm/1in/72pt 모두 mm 정합", () => {
    expect(pdOf(`<style>@page{margin:2cm}</style><p>x</p>`)!.left).toBe(mm(20));
    expect(pdOf(`<style>@page{margin:1in}</style><p>x</p>`)!.left).toBe(mm(25.4));
    expect(pdOf(`<style>@page{margin:72pt}</style><p>x</p>`)!.left).toBe(mm(25.4));
  });

  // F-01(Codex): CSS 무단위 0 — margin:0 등 흔한 초기화. 단위 없어도 0mm 로 반영돼야.
  it("margin:0 (무단위) → 4면 0", () => {
    const pd = pdOf(`<style>@page{margin:0}</style><p>x</p>`)!;
    expect([pd.left, pd.right, pd.top, pd.bottom]).toEqual([0, 0, 0, 0]);
  });

  it("margin:10mm 0 단축 → 상하=10mm / 좌우=0", () => {
    const pd = pdOf(`<style>@page{margin:10mm 0}</style><p>x</p>`)!;
    expect(pd.top).toBe(mm(10));
    expect(pd.left).toBe(0);
    expect(pd.right).toBe(0);
  });
});

describe("wku: F-02(Codex) 파서 견고성 — 주석/다중 @page", () => {
  it("@page 내부 주석 제거 후 size 정상 파싱", () => {
    const pd = pdOf(`<style>@page{ /* A4 가로 */ size:A4 landscape }</style><p>x</p>`)!;
    expect(pd.landscape).toBe(true);
    expect(pd.width).toBe(A4_SHORT);
  });

  it("다중 bare @page 병합 — size 블록 + margin 블록", () => {
    const pd = pdOf(`<style>@page{size:A4 landscape} @page{margin:20mm}</style><p>x</p>`)!;
    expect(pd.landscape).toBe(true);
    expect(pd.left).toBe(mm(20));
  });

  it("같은 속성 다중 @page → 나중 블록이 덮어씀(cascade)", () => {
    const pd = pdOf(`<style>@page{margin:10mm} @page{margin:30mm}</style><p>x</p>`)!;
    expect(pd.left).toBe(mm(30));
  });

  it("셀렉터 붙은 @page(:first) 는 스킵, bare @page 만 반영", () => {
    const pd = pdOf(`<style>@page :first{margin:5mm} @page{margin:25mm}</style><p>x</p>`)!;
    expect(pd.left).toBe(mm(25));
  });
});

describe("wku: 우선순위", () => {
  it("API orientation:'portrait' > @page{size:A4 landscape} → 세로(API 승)", () => {
    const pd = pdOf(`<style>@page{size:A4 landscape}</style><p>x</p>`, { orientation: "portrait" })!;
    expect(pd.landscape).toBe(false);
  });

  it("API margins.left > @page margin (면별 병합)", () => {
    const pd = pdOf(`<style>@page{margin:30mm}</style><p>x</p>`, { margins: { left: 15 } })!;
    expect(pd.left).toBe(mm(15)); // API 승
    expect(pd.right).toBe(mm(30)); // @page 잔여 면
  });

  it("@page margin > 컨테이너 padding", () => {
    const pd = pdOf(`<style>@page{margin:30mm}</style><div style="padding:10px">본문</div>`)!;
    expect(pd.left).toBe(mm(30)); // @page 승, 컨테이너 10px 아님
  });
});

describe("wku: 무회귀", () => {
  it("@page 無 + 옵션 無 → pageDef undefined (기존 폴백)", () => {
    expect(pdOf(`<p>본문</p>`)).toBeUndefined();
  });

  it("@page 없는 <style>(@page 무관 규칙) → 신호 없음 → undefined", () => {
    expect(pdOf(`<style>p{color:red}</style><p>본문</p>`)).toBeUndefined();
  });
});
