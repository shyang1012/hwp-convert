/**
 * c97 — 가로 문서 본문폭 반영. HWPX 빌더가 세로 A4 하드코딩(42520) 대신 섹션 pageDef 에서
 * 유효 본문폭을 도출(가로=height−여백, 세로=width−여백)해 표/이미지/lineseg 에 반영하는지 검증.
 *
 * landscape 는 치수 스왑이 아니라 플래그이므로(메모리 hwpx-landscape-semantics) 가로 유효폭=height.
 * 세로 경로는 정확히 42520 으로 떨어져 무회귀.
 * [shyang 2026-06-26]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpx } from "../src/lib/hwp/index.js";
import type { PageSetupOption } from "../src/lib/hwp/types.js";

const A4_SHORT = 59528;
const A4_LONG = 84186;
const MARGIN = 8504; // buildSecPr 기본 좌/우 여백
const PORTRAIT_BODY = A4_SHORT - MARGIN * 2; // 42520
const LANDSCAPE_BODY = A4_LONG - MARGIN * 2; // 67178

const TABLE_3COL = `<table><tr><td>가</td><td>나</td><td>다</td></tr></table>`;

async function section0(html: string, page?: PageSetupOption): Promise<string> {
  const out = await htmlToHwpx(html, page ? { page } : undefined);
  const zip = await JSZip.loadAsync(out);
  return zip.file("Contents/section0.xml")!.async("string");
}

/** 첫 hp:tbl 의 sz width(표 전체 폭). */
function tableWidth(sec: string): number {
  const tbl = sec.match(/<hp:tbl\b[\s\S]*?<hp:sz width="(\d+)"/);
  return tbl ? Number(tbl[1]) : -1;
}

describe("c97: 표 본문폭 — 무열폭 표는 본문폭 균등분할", () => {
  it("세로(기본) 3열 표 → 표 폭 = 세로 본문폭(42520) 근사", async () => {
    const w = tableWidth(await section0(TABLE_3COL));
    // 균등분할 floor 누적(42520/3=14173·3=42519). 42520 근처, 가로폭(67178)과 명확히 구분.
    expect(w).toBeGreaterThan(PORTRAIT_BODY - 5);
    expect(w).toBeLessThanOrEqual(PORTRAIT_BODY);
  });

  it("가로(landscape) 3열 표 → 표 폭 = 가로 본문폭(67178) 근사", async () => {
    const w = tableWidth(await section0(TABLE_3COL, { orientation: "landscape" }));
    expect(w).toBeGreaterThan(LANDSCAPE_BODY - 5);
    expect(w).toBeLessThanOrEqual(LANDSCAPE_BODY);
    // 회귀 가드: 세로폭으로 떨어지지 않아야 함.
    expect(w).toBeGreaterThan(PORTRAIT_BODY);
  });

  it("가로 표 셀 폭 = 가로 본문폭/열수 (세로폭/열수 아님)", async () => {
    const sec = await section0(TABLE_3COL, { orientation: "landscape" });
    const cell = Number(sec.match(/<hp:cellSz width="(\d+)"/)![1]);
    expect(cell).toBe(Math.floor(LANDSCAPE_BODY / 3)); // 22392
    expect(cell).not.toBe(Math.floor(PORTRAIT_BODY / 3)); // 14173
  });
});

describe("c97: content lineseg horzsize — 본문폭 반영", () => {
  it("가로 문서 본문 문단 lineseg horzsize = 가로 본문폭", async () => {
    const sec = await section0(`<p>짧은 문단</p>`, { orientation: "landscape" });
    expect(sec).toContain(`horzsize="${LANDSCAPE_BODY}"`);
  });

  it("세로 문서는 가로 본문폭 horzsize 가 나타나지 않음(무회귀)", async () => {
    const sec = await section0(`<p>짧은 문단</p>`);
    expect(sec).not.toContain(`horzsize="${LANDSCAPE_BODY}"`);
    expect(sec).toContain(`horzsize="${PORTRAIT_BODY}"`);
  });
});

describe("c97: 명시 커스텀 여백/제본 차감", () => {
  it("가로 + 좌우 여백 mm 명시 → 본문폭 = height − 좌 − 우", async () => {
    const sec = await section0(TABLE_3COL, {
      orientation: "landscape",
      margins: { left: 20, right: 20 }, // mm
    });
    const leftR = Math.round((20 * 7200) / 25.4); // mm→HWPUNIT
    const expectBody = A4_LONG - leftR * 2;
    const w = tableWidth(sec);
    expect(w).toBeGreaterThan(expectBody - 5);
    expect(w).toBeLessThanOrEqual(expectBody);
  });

  // F-01(Codex audit): 여백 합이 용지를 넘는 병리적 입력 → 세로A4(42520) 자의적 복귀가 아니라
  // 여백 무시하고 용지 가로폭(가로=height) 폴백. 가로 페이지에서 너무 좁아지지 않게.
  it("가로 + 비정상 과대여백(용지 초과) → 용지 가로폭(height) 폴백, 42520 아님", async () => {
    const sec = await section0(TABLE_3COL, {
      orientation: "landscape",
      margins: { left: 500, right: 500 }, // mm — A4 height(297mm) 훨씬 초과
    });
    const w = tableWidth(sec);
    expect(w).toBeGreaterThan(PORTRAIT_BODY); // 42520 으로 떨어지지 않음
    expect(w).toBeGreaterThan(A4_LONG - 5); // ≈ 용지 가로폭(84186) 균등분할 합
    expect(w).toBeLessThanOrEqual(A4_LONG);
  });
});
