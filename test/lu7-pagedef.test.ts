/**
 * lu7 — HWP→HWPX 섹션별 페이지설정(PAGE_DEF) 보존 검증.
 *
 * HWP 원본의 secd→PAGE_DEF(용지/여백)를 HWPX 출력 <hp:secPr> 에 반영하는지,
 * 한컴 정상 출력(.hwpx 정답지)과 라운드트립 대조한다.
 *   입력:   etc/test source/hwp-convert-lu7/…비바테크….hwp  (한컴 HWP 5.0 변환본)
 *   정답지: 같은 폴더 …비바테크….hwpx                       (한컴 정상 출력)
 *
 * 픽스처(개발 로컬)가 없으면 스킵.
 * [shyang 2026-06-22]
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

const LU7_DIR = "etc/test source/hwp-convert-lu7";
const BASE = "260618_K-스타트업_비바테크(VIVTECH)를_발판으로_유럽_무대_진출";
const HWP_PATH = pickFixture(
  resolve(`test/fixtures/${BASE}.hwp`),
  resolve(`${LU7_DIR}/${BASE}.hwp`)
);
const HWPX_REF_PATH = pickFixture(
  resolve(`test/fixtures/${BASE}.hwpx`),
  resolve(`${LU7_DIR}/${BASE}.hwpx`)
);

/** secPr 의 pagePr@width/height 와 margin 7종을 추출. */
function extractPageMetrics(sectionXml: string): Record<string, string> | null {
  const pagePr = sectionXml.match(/<hp:pagePr\b([^>]*)>/);
  const margin = sectionXml.match(/<hp:margin\b([^/>]*)\/?>/);
  if (!pagePr || !margin) return null;
  const attrs = (s: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
    return out;
  };
  const p = attrs(pagePr[1]);
  const m = attrs(margin[1]);
  return {
    width: p.width,
    height: p.height,
    left: m.left,
    right: m.right,
    top: m.top,
    bottom: m.bottom,
    header: m.header,
    footer: m.footer,
    gutter: m.gutter,
  };
}

async function section0(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return await zip.file("Contents/section0.xml")!.async("string");
}

describe("lu7: HWP→HWPX 섹션 페이지설정(PAGE_DEF) 보존", () => {
  it.runIf(HWP_PATH && HWPX_REF_PATH)(
    "secPr 용지/여백이 원본 PAGE_DEF(=정답 hwpx)와 일치",
    async () => {
      const out = await hwpToHwpx(readFileSync(HWP_PATH!));
      const got = extractPageMetrics(await section0(out));

      // 정답지(한컴 정상 출력)에서 기대값을 동적 추출
      const refZip = await JSZip.loadAsync(readFileSync(HWPX_REF_PATH!));
      const refSec = await refZip.file("Contents/section0.xml")!.async("string");
      const want = extractPageMetrics(refSec);

      expect(got).not.toBeNull();
      expect(want).not.toBeNull();
      expect(got).toEqual(want);

      // 관공서 커스텀 여백(좌우 20mm=5669, 상하 10mm=2834)이 기본 프리셋(8504/5668)으로
      // 뭉개지지 않았음을 명시적으로 고정.
      expect(got!.left).toBe("5669");
      expect(got!.right).toBe("5669");
      expect(got!.top).toBe("2834");
      expect(got!.bottom).toBe("2834");
      expect(got!.header).toBe("2834");
      expect(got!.footer).toBe("2834");
      expect(got!.width).toBe("59528");
      expect(got!.height).toBe("84186");
    }
  );
});
