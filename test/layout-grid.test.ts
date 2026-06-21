/**
 * a2m — HTML div CSS 다단(display:grid / display:flex row) → HWP 표(테두리 없는 레이아웃 표) 변환.
 * 가로 다단 컨테이너를 1행 N열 표로 합성해 좌우 배치를 보존한다.
 * [shyang 2026-06-21]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpx } from "../src/lib/hwp/index.js";

async function sectionOf(html: string): Promise<string> {
  const zip = await JSZip.loadAsync(await htmlToHwpx(html));
  return await zip.file("Contents/section0.xml")!.async("string");
}

function tblCount(xml: string): number {
  return (xml.match(/<hp:tbl/g) || []).length;
}

describe("a2m div 다단 → 표 변환", () => {
  it("display:grid 2칼럼(블록 자식) → 1행 2열 표, 텍스트 좌우 보존", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns: 300px 100px"><div>좌측</div><div>우측</div></div>`
    );
    expect(tblCount(sec)).toBe(1);
    expect(sec).toMatch(/rowCnt="1" colCnt="2"/);
    expect(sec).toContain("좌측");
    expect(sec).toContain("우측");
  });

  it("레이아웃 표는 테두리 없음 (tbl·셀 borderFillIDRef=1)", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns: 100px 100px"><div>A</div><div>B</div></div>`
    );
    expect(sec).toMatch(/<hp:tbl[^>]*borderFillIDRef="1"/);
    expect(sec).toMatch(/<hp:tc[^>]*borderFillIDRef="1"/);
  });

  it("grid-template-columns 비율(300px:100px)이 셀 너비에 3:1 로 반영", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns: 300px 100px"><div>A</div><div>B</div></div>`
    );
    const widths = [...sec.matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths.length).toBe(2);
    const ratio = widths[0] / widths[1];
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(3.5);
  });

  it("display:flex; flex-direction:row(블록 자식) → 2열 표", async () => {
    const sec = await sectionOf(
      `<div style="display:flex; flex-direction:row"><div>L</div><div>R</div></div>`
    );
    expect(tblCount(sec)).toBe(1);
    expect(sec).toMatch(/colCnt="2"/);
  });

  it("NEGATIVE: 인라인 자식 flex-row 는 표로 안 바꾸고 한 줄 인라인 유지", async () => {
    const sec = await sectionOf(
      `<div style="display:flex; flex-direction:row"><span>상호</span><span>테스트</span></div>`
    );
    expect(tblCount(sec)).toBe(0);
    expect(sec).toContain("상호");
    expect(sec).toContain("테스트");
  });

  it("NEGATIVE: flex-direction:column 은 표로 안 바꾸고 세로 문단 유지", async () => {
    const sec = await sectionOf(
      `<div style="display:flex; flex-direction:column"><div>A</div><div>B</div></div>`
    );
    expect(tblCount(sec)).toBe(0);
    expect(sec).toContain("A");
    expect(sec).toContain("B");
  });

  it("F-01: 중첩 grid 는 바깥 표 셀 안에 중첩 표로 보존(세로로 안 무너짐)", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns:50px 50px">` +
        `<div style="display:grid; grid-template-columns:50px 50px"><div>A</div><div>B</div></div>` +
        `<div>C</div>` +
        `</div>`
    );
    expect(tblCount(sec)).toBeGreaterThanOrEqual(2); // 바깥 + 중첩
    expect(sec).toContain("A");
    expect(sec).toContain("B");
    expect(sec).toContain("C");
  });

  it("F-02: 의미있는 텍스트가 블록과 섞이면 표 변환 안 함(내용 유실 방지)", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns:100px 100px">라벨<div>A</div><div>B</div></div>`
    );
    expect(tblCount(sec)).toBe(0);
    expect(sec).toContain("라벨"); // 유실 없음
    expect(sec).toContain("A");
    expect(sec).toContain("B");
  });
});
