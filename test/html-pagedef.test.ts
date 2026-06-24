/**
 * p1x — HTML→HWPX 용지/여백 보존 검증.
 *
 * htmlReader 가 루트 컨테이너 CSS(padding/max-width)를 HwpPageDef 로 도출해
 * section.pageDef 에 싣고(빌더 무변경, buildSecPr 인프라 재사용), 본문폭이 A4 세로
 * 가용폭을 넘으면 A4 가로로 전환하는지 확인한다.
 *
 * IR 단위 테스트는 픽스처 없이 항상 돌고, 끝의 e2e 는 etc/test source/06.preview.html
 * 이 있을 때만(개발 로컬) secPr 까지 라운드트립 검증한다.
 * [shyang 2026-06-24]
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";

import { htmlToHwpDocument } from "../src/lib/hwp/converter.js";
import { htmlToHwpx } from "../src/lib/hwp/index.js";

function pageDefOf(html: string) {
  return htmlToHwpDocument(html).sections[0].pageDef;
}

// A4 치수(HWPUNIT)
const A4_SHORT = 59528;
const A4_LONG = 84186;

describe("p1x: HTML→HWPX 용지/여백 보존", () => {
  it("1. padding(32px 40px) → 상하 2400 / 좌우 3000 여백", () => {
    const pd = pageDefOf(`<div style="padding:32px 40px; max-width:840px">본문</div>`);
    expect(pd).toBeDefined();
    expect(pd!.left).toBe(3000);
    expect(pd!.right).toBe(3000);
    expect(pd!.top).toBe(2400);
    expect(pd!.bottom).toBe(2400);
  });

  it("2. max-width:840px → A4 가로 전환(width>height)", () => {
    const pd = pageDefOf(`<div style="padding:32px 40px; max-width:840px">본문</div>`)!;
    expect(pd.landscape).toBe(true);
    expect(pd.width).toBe(A4_LONG);
    expect(pd.height).toBe(A4_SHORT);
    expect(pd.width).toBeGreaterThan(pd.height);
  });

  it("3. padding 없는 컨테이너 → 관습 기본 여백 폴백(좌우 8504 등)", () => {
    const pd = pageDefOf(`<div style="max-width:400px">본문</div>`)!;
    expect(pd.left).toBe(8504);
    expect(pd.right).toBe(8504);
    expect(pd.top).toBe(5668);
    expect(pd.bottom).toBe(4252);
    expect(pd.header).toBe(4252);
    expect(pd.footer).toBe(4252);
    expect(pd.gutter).toBe(0);
  });

  it("4. 좁은 본문(max-width:400px) → 세로 유지(landscape=false)", () => {
    const pd = pageDefOf(`<div style="max-width:400px">본문</div>`)!;
    expect(pd.landscape).toBe(false);
    expect(pd.width).toBe(A4_SHORT);
    expect(pd.height).toBe(A4_LONG);
  });

  it("5. 컨테이너/스타일 단서 전무 → pageDef 미생성(빌더 기본 폴백)", () => {
    expect(pageDefOf(`<p>그냥 문단</p>`)).toBeUndefined();
    expect(pageDefOf(`<div>스타일 없는 컨테이너</div>`)).toBeUndefined();
  });

  it("6. 비px 단위(80% / auto) → 너비 미인식, 세로 유지 + padding 여백만 반영", () => {
    const pd = pageDefOf(`<div style="max-width:80%; padding:20px">본문</div>`)!;
    expect(pd.landscape).toBe(false);
    expect(pd.width).toBe(A4_SHORT);
    expect(pd.left).toBe(1500); // padding 20px
    // auto 도 동일하게 미인식
    const pd2 = pageDefOf(`<div style="width:auto; padding:20px">본문</div>`)!;
    expect(pd2.landscape).toBe(false);
  });

  it("7. 부분 padding(padding-left만) → 해당 면만, 나머지 면 관습 기본", () => {
    const pd = pageDefOf(`<div style="padding-left:40px">본문</div>`)!;
    expect(pd.left).toBe(3000);
    expect(pd.right).toBe(8504);
    expect(pd.top).toBe(5668);
    expect(pd.bottom).toBe(4252);
  });

  it("8. 다중 최상위 노드 + 앞쪽 텍스트/공백 → 첫 의미 블록만 컨테이너로 식별", () => {
    const html = `  앞쪽 텍스트<span>인라인</span><div style="padding:50px">첫 블록</div><div style="padding:10px">둘째</div>`;
    const pd = pageDefOf(html)!;
    expect(pd.left).toBe(3750); // 첫 div 의 50px (둘째 div 10px=750 이 아님)
  });

  it("9. 전체 문서(html>body>div) → body 내부 첫 블록에서 추출", () => {
    const pd = pageDefOf(
      `<html><head><title>t</title></head><body><div style="padding:25px; max-width:840px">본문</div></body></html>`
    )!;
    expect(pd.left).toBe(1875); // padding 25px
    expect(pd.landscape).toBe(true); // max-width 840px
    expect(pd.width).toBe(A4_LONG);
  });
});

// ── e2e: 실제 픽스처(06.preview.html)로 secPr 까지 라운드트립 (로컬에서만) ──

function pickFixture(...candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const PREVIEW_HTML = pickFixture(
  resolve("test/fixtures/06.preview.html"),
  resolve("etc/test source/06.preview.html")
);

function extractPagePr(sectionXml: string): Record<string, string> | null {
  const pagePr = sectionXml.match(/<hp:pagePr\b([^>]*)>/);
  const margin = sectionXml.match(/<hp:margin\b([^/>]*)\/?>/);
  if (!pagePr || !margin) return null;
  const attrs = (s: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
    return out;
  };
  return { ...attrs(pagePr[1]), ...attrs(margin[1]) };
}

describe("p1x: 06.preview.html e2e (픽스처 있을 때만)", () => {
  it.runIf(PREVIEW_HTML)("secPr 이 A4 가로 + padding 여백을 반영", async () => {
    const out = await htmlToHwpx(readFileSync(PREVIEW_HTML!, "utf-8"));
    const zip = await JSZip.loadAsync(out);
    const sec = await zip.file("Contents/section0.xml")!.async("string");
    const m = extractPagePr(sec)!;
    expect(m).not.toBeNull();
    // 루트 div: padding:32px 40px; max-width:840px → A4 가로 + 좌우 3000/상하 2400
    expect(Number(m.width)).toBe(A4_LONG);
    expect(Number(m.height)).toBe(A4_SHORT);
    expect(m.left).toBe("3000");
    expect(m.right).toBe("3000");
    expect(m.top).toBe("2400");
    expect(m.bottom).toBe("2400");
  });
});
