/**
 * E2E 변환 파이프라인 테스트.
 *
 * 실제 사용자 작성 md(etc/e2emd.md)를 두 경로로 HWPX 변환하고,
 * 한컴 호환 패키지 구조 + 내용(제목/본문/표) 보존을 round-trip 으로 검증한다.
 *   1) md → hwpx (markdownToHwpx)
 *   2) md → html(marked) → hwpx (htmlToHwpx)
 *
 * 한글에서 실제 열리는지는 수동(hwp MCP)으로 별도 확인.
 * [shyang 2026-06-21]
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { marked } from "marked";
import JSZip from "jszip";

import HwpxReader from "../src/lib/hwpxReader.js";
import { markdownToHwpx, htmlToHwpx } from "../src/lib/hwp/index.js";

/** test/fixtures(커밋됨) 우선, 없으면 etc(개발 로컬) 폴백. */
function pickFixture(...candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const MD_PATH = pickFixture(resolve("test/fixtures/e2emd.md"), resolve("etc/e2emd.md"));
const md = MD_PATH ? readFileSync(MD_PATH, "utf-8") : null;

const IMG_MD_PATH = pickFixture(resolve("test/fixtures/e2emd_img.md"), resolve("etc/e2emd_img.md"));
const imgMd = IMG_MD_PATH ? readFileSync(IMG_MD_PATH, "utf-8") : null;

async function roundTripText(bytes: Uint8Array): Promise<string> {
  const r = new HwpxReader();
  await r.loadFromArrayBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  return await r.extractText();
}

/** 한컴 호환 패키지 공통 검증: mimetype, 속성 prefix 부재, secPr. */
async function assertHancomPackage(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  expect(await zip.file("mimetype")!.async("string")).toBe("application/hwp+zip");
  const sec = await zip.file("Contents/section0.xml")!.async("string");
  expect(sec).toContain("<hp:secPr");
  // xmlns 제외 후 prefix 붙은 속성이 없어야 함
  const stripped = sec.replace(/xmlns:[a-zA-Z0-9]+="[^"]*"/g, "");
  expect(/\s(hh|hp|hc):[a-zA-Z]+=/.test(stripped)).toBe(false);
  return sec;
}

describe("E2E: etc/e2emd.md", () => {
  it.runIf(md)("경로 1 — md → hwpx: 제목/본문/표 보존 + 한컴 호환", async () => {
    const bytes = await markdownToHwpx(md!);
    const sec = await assertHancomPackage(bytes);
    expect(sec).toContain("<hp:tbl");

    const text = await roundTripText(bytes);
    expect(text).toContain("테스트Md");
    expect(text).toContain("정상적으로");
    expect(text).toContain("테스트데이터");
    expect(text).toContain("코덱스");
    expect(text).toContain("opus 4.8");
  });

  it.runIf(md)("경로 2 — md → html(marked) → hwpx: 동일 내용 보존", async () => {
    const html = await marked.parse(md!);
    const bytes = await htmlToHwpx(html);
    const sec = await assertHancomPackage(bytes);
    expect(sec).toContain("<hp:tbl");

    const text = await roundTripText(bytes);
    expect(text).toContain("테스트Md");
    expect(text).toContain("테스트데이터");
    expect(text).toContain("코덱스");
    expect(text).toContain("opus 4.8");
  });

  it.runIf(imgMd)("data URI 이미지 md → hwpx: BinData 임베드 + hp:pic", async () => {
    const bytes = await markdownToHwpx(imgMd!);
    await assertHancomPackage(bytes);
    const zip = await JSZip.loadAsync(bytes);
    const bins = Object.keys(zip.files).filter(
      (p) => p.startsWith("BinData/") && !p.endsWith("/")
    );
    expect(bins.length).toBeGreaterThan(0);
    expect(bins[0]).toMatch(/\.png$/i);
    const sec = await zip.file("Contents/section0.xml")!.async("string");
    expect(sec).toContain("<hp:pic");
    expect(sec).toContain('binaryItemIDRef="image1"');
    // content.hpf 에 isEmbeded 등록
    const hpf = await zip.file("Contents/content.hpf")!.async("string");
    expect(hpf).toMatch(/<opf:item[^>]*id="image1"[^>]*isEmbeded="1"/);
  });

  it.runIf(md)("두 경로 모두 표를 3행×4열로 만든다", async () => {
    const fromMd = await JSZip.loadAsync(await markdownToHwpx(md!));
    const secMd = await fromMd.file("Contents/section0.xml")!.async("string");
    // 헤더 1 + 데이터 2 = 3행, 4열
    expect(secMd).toMatch(/<hp:tbl[^>]*rowCnt="3"[^>]*colCnt="4"/);

    const html = await marked.parse(md!);
    const fromHtml = await JSZip.loadAsync(await htmlToHwpx(html));
    const secHtml = await fromHtml.file("Contents/section0.xml")!.async("string");
    expect(secHtml).toMatch(/<hp:tbl[^>]*rowCnt="3"[^>]*colCnt="4"/);
  });
});

/** 헤더 px 만 유효한 가짜 PNG 데이터 URI(치수 파싱용). */
function fakePngDataUri(w: number, h: number): string {
  const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ...be32(w), ...be32(h), 8, 6, 0, 0, 0,
  ]);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

describe("E2E: HTML 폼 충실도 (배경/다단/테두리/마감/도장박스/이미지)", () => {
  // 한 문서에 이번 릴리스의 HTML→HWPX 대표 기능을 모두 담아 회귀 고정(인라인 — 항상 실행).
  const html =
    `<div style="background-color: rgb(26,82,118)"><strong>발주서</strong></div>` + // 배경 박스
    `<div style="display:grid; grid-template-columns: 100px 100px; gap: 9px">` + // 다단 + gap
    `<div style="border: 1px solid rgb(209,213,220); padding: 9px; vertical-align: top">발주처</div>` + // 테두리+여백+세로정렬
    `<div>공급처</div></div>` +
    `<table><tr><td style="background-color: rgb(243,244,246)">헤더</td></tr></table>` + // 셀 배경
    `<p>서명 <span style="border: 1px solid rgb(0,0,0)"></span></p>` + // 도장박스
    `<p><img src="${fakePngDataUri(200, 100)}" style="width: 50%"></p>`; // 이미지 비율+width

  it("한 변환에 6대 기능이 OWPML 로 모두 출력된다", async () => {
    const bytes = await htmlToHwpx(html);
    const zip = await JSZip.loadAsync(bytes);
    const header = await zip.file("Contents/header.xml")!.async("string");
    const sec = await assertHancomPackage(bytes); // mimetype/prefix/secPr

    // 1) 배경 박스(igp): 제목 남색 채우기
    expect(header).toContain('faceColor="#1A5276"');
    // 2) 다단(a2m) + gap: 2열 레이아웃 표 + cellSpacing(9px→675)
    expect(sec).toMatch(/<hp:tbl[^>]*colCnt="2"[^>]*>/);
    expect(sec).toMatch(/<hp:tbl[^>]*cellSpacing="675"/);
    // 3) CSS 테두리: borderFill 4면 SOLID + 색
    expect(header).toContain('color="#D1D5DC"');
    // 4) 마감: padding→cellMargin(9px→675), vertical-align→TOP
    expect(sec).toContain('<hp:cellMargin left="675" right="675" top="675" bottom="675"/>');
    expect(sec).toMatch(/vertAlign="TOP"/);
    // 5) 셀 배경(데이터 표) 채우기
    expect(header).toContain('faceColor="#F3F4F6"');
    // 6) 도장박스: 글자 테두리 charPr borderFillIDRef≥3
    const charRefs = [...header.matchAll(/<hh:charPr[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    expect(charRefs.some((r) => r >= 3)).toBe(true);
    // 7) 이미지: hp:pic + 원본 비율(200:100) 보존, width:50%→21260×10630
    expect(sec).toContain("<hp:pic");
    expect(sec).toContain('<hp:sz width="21260" widthRelTo="ABSOLUTE" height="10630"');
  });
});
