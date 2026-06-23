/**
 * 패키징 충실도 — HWP→HWPX 패키지가 한컴 정상 출력의 구조/압축을 따르는지 검증.
 *   - ZIP DEFLATE(압축 가능 콘텐츠) vs STORE(mimetype/이미 압축된 jpg/png)
 *   - META-INF/container.rdf, 빈 odf:manifest, content.hpf(settings + 원본 확장자 케이스)
 *   - 다중 섹션 보존
 *
 * 입력/정답지(개발 로컬, 없으면 스킵):
 *   etc/test source/hwp테스트소스/…박람회…-section.hwp  +  같은 이름 -section.hwpx(정답)
 * [shyang 2026-06-23]
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
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

describe("패키징 충실도 — 다중섹션 HWP→HWPX", () => {
  it.runIf(HWP_PATH)("DEFLATE 압축으로 정답급 크기 + mimetype/jpg 는 STORE", async () => {
    const out = await hwpToHwpx(readFileSync(HWP_PATH!));
    const zip = await JSZip.loadAsync(out);

    // 압축 증거: 무압축이면 BMP 만으로 ~2MB. 압축 적용 시 그보다 훨씬 작아야.
    expect(out.length).toBeLessThan(900_000);
    if (HWPX_REF_PATH) {
      expect(out.length).toBeLessThan(statSync(HWPX_REF_PATH!).size * 1.4);
    }

    // mimetype 은 STORE(평문) — OCF 규약. 출력 바이트에 평문 그대로 존재.
    const head = Buffer.from(out.slice(0, 200)).toString("latin1");
    expect(head).toContain("mimetype");
    expect(head).toContain("application/");

    // 다중 섹션 보존
    expect(zip.file("Contents/section0.xml")).not.toBeNull();
    expect(zip.file("Contents/section1.xml")).not.toBeNull();
  });

  it.runIf(HWP_PATH)("구조 정합: container.rdf, 빈 odf:manifest, content.hpf(settings+원본 확장자)", async () => {
    const out = await hwpToHwpx(readFileSync(HWP_PATH!));
    const zip = await JSZip.loadAsync(out);

    // container.rdf 존재 + part 등록(header/sectionN/Document)
    const rdf = await zip.file("META-INF/container.rdf")?.async("string");
    expect(rdf).toBeTruthy();
    expect(rdf).toContain("HeaderFile");
    expect(rdf).toContain("SectionFile");
    expect(rdf).toContain("#Document");

    // manifest.xml = 빈 odf:manifest
    const manifest = await zip.file("META-INF/manifest.xml")!.async("string");
    expect(manifest).toMatch(/<odf:manifest[^>]*\/>/);
    expect(manifest).not.toContain("file-entry");

    // content.hpf: settings 항목 + 원본 확장자 케이스 보존(이 픽스처는 대문자 .BMP/.JPG)
    const hpf = await zip.file("Contents/content.hpf")!.async("string");
    expect(hpf).toContain('href="settings.xml"');
    expect(hpf).toMatch(/BinData\/image\d+\.(BMP|JPG)/); // 원본 대문자 보존
  });

  it.runIf(HWP_PATH && HWPX_REF_PATH)("BinData 확장자 케이스가 정답과 일치(원본 보존)", async () => {
    const out = await hwpToHwpx(readFileSync(HWP_PATH!));
    const binFiles = (names: string[]) => names.filter((n) => n.startsWith("BinData/") && !n.endsWith("/"));
    const ours = binFiles(Object.keys((await JSZip.loadAsync(out)).files));
    const ref = binFiles(Object.keys((await JSZip.loadAsync(readFileSync(HWPX_REF_PATH!))).files));
    // 확장자(케이스 포함) 집합 일치
    const exts = (xs: string[]) => new Set(xs.map((n) => n.replace(/.*\./, "")));
    expect(exts(ours)).toEqual(exts(ref));
  });
});
