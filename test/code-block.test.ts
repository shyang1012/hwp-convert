/**
 * <pre> 코드블록 충실도 — HTML→HWPX 가 배경·테두리·구문강조(토큰) 색·줄바꿈을 보존하는지 검증.
 *   - 코드블록은 1×1 표 셀(채우기+테두리)로 합성 → 한글에서 박스로 렌더.
 *   - 토큰 <span style="color"> → 색 charPr run.
 *   - white-space:pre 의 개행/들여쓰기/빈 줄 보존.
 * 기준: etc/test source/code-block-inline.html (Prism one-light 토큰색 inline 구조).
 * [shyang 2026-06-24]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpx } from "../src/lib/hwp/index.js";

async function secHeader(html: string): Promise<{ sec: string; header: string }> {
  const zip = await JSZip.loadAsync(await htmlToHwpx(html));
  return {
    sec: await zip.file("Contents/section0.xml")!.async("string"),
    header: await zip.file("Contents/header.xml")!.async("string"),
  };
}

/** section 내 첫 표 XML. */
function firstTable(sec: string): string {
  return /<hp:tbl[\s\S]*?<\/hp:tbl>/.exec(sec)?.[0] ?? "";
}

/** 셀 borderFillIDRef → header 의 해당 borderFill XML. */
function borderFillOf(header: string, id: string): string {
  return new RegExp(`<hh:borderFill id="${id}"[\\s\\S]*?</hh:borderFill>`).exec(header)?.[0] ?? "";
}

const PRE_BG_BORDER =
  `<pre style="background-color: rgb(250,250,250); border: 1px solid rgb(209,213,219); ` +
  `padding: 15px; white-space: pre; font-family: monospace;">` +
  `<code><span style="color: rgb(166,38,164);">export</span> interface User {\n\n` +
  `  <span style="color: rgb(80,161,79);">"hello"</span>\n}</code></pre>`;

describe("<pre> 코드블록 충실도 (배경·테두리·토큰색·줄바꿈)", () => {
  it("코드블록이 1×1 표로 합성된다", async () => {
    const { sec } = await secHeader(PRE_BG_BORDER);
    const tbl = firstTable(sec);
    expect(tbl).toBeTruthy();
    expect(tbl).toMatch(/rowCnt="1"\s+colCnt="1"|colCnt="1"/);
    expect(tbl.match(/<hp:tc/g)!.length).toBe(1); // 단일 셀
  });

  it("셀 배경(#FAFAFA) + 테두리(#D1D5DB SOLID) borderFill 참조", async () => {
    const { sec, header } = await secHeader(PRE_BG_BORDER);
    const tbl = firstTable(sec);
    const ref = /<hp:tc\b[^>]*borderFillIDRef="(\d+)"/.exec(tbl)![1];
    const bf = borderFillOf(header, ref);
    expect(bf).toMatch(/faceColor="#FAFAFA"/i); // pre 배경
    expect(bf).toMatch(/<hh:topBorder type="SOLID"[^>]*color="#D1D5DB"/i); // pre 테두리
  });

  it("토큰 색이 charPr 로 보존된다 (#A626A4 보라 / #50A14F 초록)", async () => {
    const { sec, header } = await secHeader(PRE_BG_BORDER);
    expect(header).toMatch(/textColor="#A626A4"/i);
    expect(header).toMatch(/textColor="#50A14F"/i);
    // 코드 셀 안 run 이 해당 charPr 를 참조(보라 charPr id 를 run 이 씀)
    const purpleId = /<hh:charPr id="(\d+)"[^>]*textColor="#A626A4"/i.exec(header)![1];
    const tbl = firstTable(sec);
    expect(tbl).toMatch(new RegExp(`charPrIDRef="${purpleId}"`));
  });

  it("개행·빈 줄 보존: 코드 줄 수만큼 셀 내부 문단 (빈 줄 포함)", async () => {
    const { sec } = await secHeader(PRE_BG_BORDER);
    const tbl = firstTable(sec);
    // export... / (빈 줄) / "hello" / } → 4줄 = 4 문단
    expect(tbl.match(/<hp:p\b/g)!.length).toBe(4);
  });

  it("들여쓰기(선행 공백) 보존", async () => {
    const { sec } = await secHeader(PRE_BG_BORDER);
    expect(sec).toMatch(/<hp:t>  /); // "  hello" 의 2칸 들여쓰기
  });
});
