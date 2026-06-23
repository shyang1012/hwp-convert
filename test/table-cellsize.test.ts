/**
 * HWP 표 셀 width/height 보존 — HWP→HWPX 변환이 셀 실치수를 보존하는지 검증.
 *   - parseCellMeta 가 col/row/colSpan/rowSpan 뒤 width(u32)/height(u32)/margins 를 읽어
 *     buildTableXml 이 DEFAULT_ROW_HEIGHT(2000) 고정 대신 실값으로 출력하는지.
 *   - 회귀: 정답 hwpx 의 헤더 표 셀 height 와 동적 대조.
 *
 * 입력/정답지(개발 로컬, 없으면 스킵):
 *   etc/test source/hwp테스트소스/…박람회…-section.hwp  +  같은 이름 -section.hwpx(정답)
 * [shyang 2026-06-23]
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";

import { hwpToHwpx } from "../src/lib/hwp/index.js";

function pickFixture(...candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const DIR = "etc/test source/hwp테스트소스";
const BASE = "20201109 KOSME 내일愛 온택트 일자리 박람회_ 이번에는 인재육성형 중소기업이다-section";
const HWP_PATH = pickFixture(resolve(`test/fixtures/${BASE}.hwp`), resolve(`${DIR}/${BASE}.hwp`));
const HWPX_REF_PATH = pickFixture(resolve(`test/fixtures/${BASE}.hwpx`), resolve(`${DIR}/${BASE}.hwpx`));

/** 첫 표의 행별 셀 height(있는 그대로, 순서 보존). */
function firstTableRowHeights(sectionXml: string): number[] {
  const tbl = sectionXml.match(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/)?.[0] ?? "";
  const trs = tbl.match(/<hp:tr\b[\s\S]*?<\/hp:tr>/g) ?? [];
  return trs.map((tr) => {
    const m = tr.match(/<hp:cellSz width="\d+" height="(\d+)"/);
    return m ? Number(m[1]) : -1;
  });
}

function firstTableSzWidth(sectionXml: string): number {
  const tbl = sectionXml.match(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/)?.[0] ?? "";
  return Number(tbl.match(/<hp:sz width="(\d+)"/)?.[1] ?? "0");
}

async function section0(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return await zip.file("Contents/section0.xml")!.async("string");
}

describe("HWP 표 셀 width/height 보존 (hwp-convert-cm7)", () => {
  it.runIf(HWP_PATH && HWPX_REF_PATH)("헤더 표 행 높이가 정답 hwpx 와 일치 (DEFAULT 2000 고정 아님)", async () => {
    const ourSec = await section0(await hwpToHwpx(readFileSync(HWP_PATH!)));
    const refSec = await section0(readFileSync(HWPX_REF_PATH!));

    const got = firstTableRowHeights(ourSec);
    const want = firstTableRowHeights(refSec);

    expect(got.length).toBe(want.length);
    expect(got).toEqual(want); // 행별 높이 1:1 (2837/3916/0/2231/382/2231 …)
    // 모든 행이 2000(DEFAULT_ROW_HEIGHT) 으로 뭉개지지 않았음을 명시
    expect(got.every((h) => h === 2000)).toBe(false);
    // 빈 행(height 0) 보존
    expect(got).toContain(0);
  });

  it.runIf(HWP_PATH && HWPX_REF_PATH)("표 sz width 가 정답과 일치(균등분할 아님)", async () => {
    const ourSec = await section0(await hwpToHwpx(readFileSync(HWP_PATH!)));
    const refSec = await section0(readFileSync(HWPX_REF_PATH!));
    const got = firstTableSzWidth(ourSec);
    const want = firstTableSzWidth(refSec);
    expect(want).toBeGreaterThan(0);
    expect(Math.abs(got - want) / want).toBeLessThan(0.05); // ±5%
  });

  it.runIf(HWP_PATH)("병합셀 포함 표가 NaN/예외 없이 변환됨", async () => {
    const out = await hwpToHwpx(readFileSync(HWP_PATH!));
    const sec = await section0(out);
    // cellSz/sz 의 모든 수치가 유효(NaN 아님)
    const nums = [...sec.matchAll(/(?:width|height)="(-?\d+|NaN)"/g)].map((m) => m[1]);
    expect(nums.length).toBeGreaterThan(0);
    expect(nums).not.toContain("NaN");
  });

  // xj3.1 — 셀 borderFillID 보존(회색 격자→투명/선택 테두리)
  it.runIf(HWP_PATH && HWPX_REF_PATH)("헤더 표 셀이 SOLID 격자(id2) 강제 아니라 셀별 실 borderFill 참조", async () => {
    const zip = await JSZip.loadAsync(await hwpToHwpx(readFileSync(HWP_PATH!)));
    const sec = await zip.file("Contents/section0.xml")!.async("string");
    const hdr = await zip.file("Contents/header.xml")!.async("string");
    const tbl = sec.match(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/)![0];
    const refs = [...tbl.matchAll(/<hp:tc\b[^>]*?borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));

    // 전부 2(예약 SOLID 격자)로 뭉개지지 않고 셀별로 상이해야.
    expect(refs.every((r) => r === 2)).toBe(false);
    expect(new Set(refs).size).toBeGreaterThan(1);

    // 투명 셀(참조 borderFill 4면 NONE) 존재 — 정답의 발주처/제목 투명 경계.
    const borderTypesOf = (xml: string, id: number) => {
      const bf = xml.match(new RegExp(`<hh:borderFill id="${id}"[\\s\\S]*?</hh:borderFill>`))?.[0] ?? "";
      return [...bf.matchAll(/<hh:(?:left|right|top|bottom)Border type="(\w+)"/g)].map((m) => m[1]);
    };
    const hasTransparent = refs.some((r) => {
      const types = borderTypesOf(hdr, r);
      return types.length === 4 && types.every((t) => t === "NONE");
    });
    expect(hasTransparent).toBe(true);
  });
});
