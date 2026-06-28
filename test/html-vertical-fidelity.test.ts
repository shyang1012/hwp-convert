/**
 * HTML→HWPX 세로 충실도 — div/표 부풀음 축소 (hwp-convert-4xo).
 *
 * 두 레버 검증:
 *  (A′) HTML 문단 줄간격(130%)을 한글이 신뢰하는 lineseg spacing 으로 흘린다.
 *       단일행 문단 높이는 paraPr 가 아니라 lineseg 가 지배(메모리 hwpx-lineseg-trust)하므로,
 *       lineseg spacing = vertsize × (lineSpacing/100 − 1). 130%→0.3, 160(md/HWP)→0.6(무회귀).
 *  (B)  표만 든 앵커 문단의 빈 lineseg 를 1pt 센티넬(vertsize 120, spacing 0)로 — 표 위 빈 줄 제거.
 *       HTML 경로(tightTableAnchor)만, md/HWP 표앵커는 종전 유지.
 *
 * 계획리뷰 Codex R-20260628 F-01(표종류별)·F-02(lineseg통합)·F-03(md/HWP 무회귀) 반영.
 * [shyang 2026-06-28]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpx, markdownToHwpx } from "../src/lib/hwp/index.js";

async function sectionOf(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return await zip.file("Contents/section0.xml")!.async("string");
}

/** 특정 텍스트를 담은 <hp:p> 의 lineseg vertsize/spacing 추출. */
function linesegForText(section: string, text: string): { vertsize: number; spacing: number } | null {
  const paras = section.match(/<hp:p\b[\s\S]*?<\/hp:p>/g) ?? [];
  for (const p of paras) {
    if (!p.includes(`<hp:t>${text}</hp:t>`)) continue;
    const m = p.match(/<hp:lineseg\b[^>]*vertsize="(\d+)"[^>]*spacing="(\d+)"/);
    if (m) return { vertsize: Number(m[1]), spacing: Number(m[2]) };
  }
  return null;
}

/** 1pt 센티넬(표앵커 최소 lineseg) 개수. 표앵커만 vertsize=120 을 쓰므로 존재=표앵커 타이트화. */
function sentinelCount(section: string): number {
  return (section.match(/<hp:lineseg\b[^>]*vertsize="120"[^>]*spacing="0"/g) ?? []).length;
}

/** 본문폭(currentBodyWidth) = 콘텐츠 lineseg horzsize. secPr 기본 lineseg(고정 42520)에 가려지지
 *  않도록 전체 lineseg 중 최댓값을 본문폭으로 본다(가로 문서는 콘텐츠 horzsize 가 더 큼). */
function bodyWidthOf(section: string): number {
  const hs = [...section.matchAll(/<hp:lineseg\b[^>]*horzsize="(\d+)"/g)].map((m) => Number(m[1]));
  return hs.length ? Math.max(...hs) : 0;
}

describe("HTML→HWPX 세로 충실도", () => {
  it("A′: HTML 무명시 문단 lineseg spacing = vertsize×0.6 (기본 160% 통일)", async () => {
    const section = await sectionOf(await htmlToHwpx(`<p>안녕</p>`));
    const ls = linesegForText(section, "안녕");
    expect(ls).not.toBeNull();
    // 기본 줄간격 160%(md/HWP/한글 통일) → spacing/vertsize = 0.6
    expect(ls!.spacing).toBe(Math.round(ls!.vertsize * 0.6));
  });

  it("A′ 무회귀: md 단일행 문단 lineseg spacing = vertsize×0.6 (160% 보존)", async () => {
    const section = await sectionOf(await markdownToHwpx(`안녕`));
    const ls = linesegForText(section, "안녕");
    expect(ls).not.toBeNull();
    expect(ls!.spacing).toBe(Math.round(ls!.vertsize * 0.6));
  });

  it("B: HTML <table> 앵커 문단은 1pt 센티넬(vertsize 120, spacing 0)", async () => {
    const section = await sectionOf(
      await htmlToHwpx(`<table><tr><td>가</td><td>나</td></tr></table>`)
    );
    expect(section).toContain("<hp:tbl");
    expect(sentinelCount(section)).toBe(1);
  });

  it("B: HTML 레이아웃 표(div grid 2열) 앵커도 센티넬", async () => {
    const html = `<div style="display:grid; grid-template-columns:100px 100px"><div>좌</div><div>우</div></div>`;
    const section = await sectionOf(await htmlToHwpx(html));
    expect(sentinelCount(section)).toBe(1);
  });

  it("B: HTML 인라인 width 행(label:값) 앵커도 센티넬", async () => {
    const html = `<div style="display:flex; gap:9px"><span style="width:80px">발주일</span><span style="width:4px">:</span><span style="width:200px">예시</span></div>`;
    const section = await sectionOf(await htmlToHwpx(html));
    expect(sentinelCount(section)).toBe(1);
  });

  it("B 무회귀: md 표 앵커는 센티넬 아님(종전 buildLineSeg 유지)", async () => {
    const section = await sectionOf(await markdownToHwpx(`| 가 | 나 |\n|---|---|\n| 1 | 2 |`));
    expect(section).toContain("<hp:tbl");
    expect(sentinelCount(section)).toBe(0); // md 표앵커는 클램프(≥1000) — 센티넬 아님
  });

  it("B 한정: HTML <pre> 코드블록 표앵커는 센티넬 제외(보수적 무회귀)", async () => {
    const section = await sectionOf(
      await htmlToHwpx(`<pre style="background:#eee">code line</pre>`)
    );
    expect(section).toContain("<hp:tbl"); // pre 는 1x1 표 박스
    expect(sentinelCount(section)).toBe(0); // tightTableAnchor 미설정
  });

  // 가로 오버플로우: 레이아웃 표(gap=cellSpacing)가 컬럼합을 본문폭에 그대로 채우면
  // 한글이 표 폭 = 컬럼합 + cellSpacing×colCount 로 렌더해 우측 여백을 넘는다. 컬럼 스케일 시
  // cellSpacing 을 예약해 footprint(컬럼합 + cellSpacing×colCount) ≤ 본문폭 이 되어야 한다.
  it("C: gap 있는 grid 레이아웃 표 footprint ≤ 본문폭(우측 여백 미초과)", async () => {
    const html = `<div style="display:grid; grid-template-columns:400px 400px; gap:18px"><div>좌</div><div>우</div></div>`;
    const section = await sectionOf(await htmlToHwpx(html));
    const tbl = section.match(/<hp:tbl\b([^>]*)>\s*<hp:sz width="(\d+)"/)!;
    const cellSpacing = Number(tbl[1].match(/cellSpacing="(\d+)"/)![1]);
    const colCnt = Number(tbl[1].match(/colCnt="(\d+)"/)![1]);
    const tableW = Number(tbl[2]);
    // 본문폭 = content lineseg horzsize.
    const bodyW = bodyWidthOf(section);
    expect(cellSpacing).toBeGreaterThan(0); // gap 이 cellSpacing 으로 반영됨
    expect(tableW + cellSpacing * colCnt).toBeLessThanOrEqual(bodyW);
  });

  // 실문서 재현: @page{size:A4 landscape; margin:20mm} 명시 + grid 박스(gap). 가로(넓은 본문폭)
  // 에서 박스 footprint 가 우측 여백을 넘던 원 버그를 잠근다. (발주서 purchase-order-landscape)
  it("C: @page landscape + gap 박스도 footprint ≤ 가로 본문폭", async () => {
    const html =
      `<style>@page{size:A4 landscape; margin:20mm}</style>` +
      `<div style="display:grid; grid-template-columns:436px 436px; gap:9px"><div>발주처</div><div>공급처</div></div>`;
    const section = await sectionOf(await htmlToHwpx(html));
    const tbl = section.match(/<hp:tbl\b([^>]*)>\s*<hp:sz width="(\d+)"/)!;
    const cellSpacing = Number(tbl[1].match(/cellSpacing="(\d+)"/)![1]);
    const colCnt = Number(tbl[1].match(/colCnt="(\d+)"/)![1]);
    const tableW = Number(tbl[2]);
    const bodyW = bodyWidthOf(section);
    // @page A4 landscape 20mm → 가로 본문폭 = 297mm−40mm = 257mm ≈ 72848 HWPUNIT.
    // (세로 본문폭 42520 와 명확히 구분 — landscape 적용 확인)
    expect(bodyW).toBeGreaterThan(70000);
    expect(tableW + cellSpacing * colCnt).toBeLessThanOrEqual(bodyW);
  });
});
