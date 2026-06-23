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

async function hs(html: string): Promise<{ header: string; section: string }> {
  const zip = await JSZip.loadAsync(await htmlToHwpx(html));
  return {
    header: await zip.file("Contents/header.xml")!.async("string"),
    section: await zip.file("Contents/section0.xml")!.async("string"),
  };
}

function borderFillOf(header: string, id: number): string {
  const m = new RegExp(`<hh:borderFill id="${id}"[\\s\\S]*?</hh:borderFill>`).exec(header);
  return m ? m[0] : "";
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

describe("CSS border 반영 — 셀 테두리(borderFill)", () => {
  it("레이아웃 칼럼 div 의 border → 셀 borderFill 테두리(0.2mm SOLID #D1D5DC), 무테두리 셀은 투명(1)", async () => {
    const { header, section } = await hs(
      `<div style="display:grid; grid-template-columns:100px 100px">` +
        `<div style="border:1px solid rgb(209,213,220)">A</div><div>B</div></div>`
    );
    const refs = [...section.matchAll(/<hp:tc[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    expect(refs.length).toBe(2);
    expect(refs[0]).toBeGreaterThanOrEqual(3); // 테두리 있는 커스텀
    expect(refs[1]).toBe(1); // 투명
    const bf = borderFillOf(header, refs[0]);
    expect(bf).toContain('<hh:leftBorder type="SOLID"');
    expect(bf).toContain('color="#D1D5DC"');
    expect(bf).not.toContain("fillBrush"); // 테두리만, 채우기 없음
  });

  it("레이아웃 래퍼·무테두리 div 엔 선이 생기지 않음(tbl·셀 = 1)", async () => {
    const { section } = await hs(
      `<div style="display:grid; grid-template-columns:50px 50px"><div>A</div><div>B</div></div>`
    );
    expect(section).toMatch(/<hp:tbl[^>]*borderFillIDRef="1"/);
    const refs = [...section.matchAll(/<hp:tc[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    expect(refs.every((r) => r === 1)).toBe(true);
  });

  it("0.666667px → 0.2mm(최근접 index 3) 매핑", async () => {
    const { header, section } = await hs(
      `<div style="display:grid; grid-template-columns:50px 50px">` +
        `<div style="border:0.666667px solid rgb(0,0,0)">A</div><div>B</div></div>`
    );
    const ref = Number(/<hp:tc[^>]*borderFillIDRef="(\d+)"/.exec(section)![1]);
    expect(borderFillOf(header, ref)).toContain('width="0.2 mm"');
  });

  it("부분 테두리(border-top 만) → topBorder SOLID, leftBorder NONE", async () => {
    const { header, section } = await hs(
      `<div style="display:grid; grid-template-columns:50px 50px">` +
        `<div style="border-top:1px solid rgb(0,0,0)">A</div><div>B</div></div>`
    );
    const ref = Number(/<hp:tc[^>]*borderFillIDRef="(\d+)"/.exec(section)![1]);
    const bf = borderFillOf(header, ref);
    expect(bf).toContain('<hh:topBorder type="SOLID"');
    expect(bf).toContain('<hh:leftBorder type="NONE"');
  });

  it("레이아웃 셀 border+background → 테두리는 셀, 배경은 문단 채우기(PR-03 이중적용 방지)", async () => {
    const { header, section } = await hs(
      `<div style="display:grid; grid-template-columns:100px 100px">` +
        `<div style="border:1px solid rgb(0,0,0); background-color: rgb(0,0,255)">A</div><div>B</div></div>`
    );
    const ref = Number(/<hp:tc[^>]*borderFillIDRef="(\d+)"/.exec(section)![1]);
    const cellBf = borderFillOf(header, ref);
    expect(cellBf).toContain('<hh:leftBorder type="SOLID"'); // 셀=테두리
    expect(cellBf).not.toContain("fillBrush"); // 셀에 배경 없음(이중적용 방지)
    expect(header).toContain('faceColor="#0000FF"'); // 배경은 문단 채우기로 별도 존재
  });

  it("데이터 표 td 의 border → 셀 borderFill 색 반영(#E5E7EB)", async () => {
    const { header, section } = await hs(
      `<table><tr><td style="border:1px solid rgb(229,231,235)">x</td></tr></table>`
    );
    const ref = Number(/<hp:tc[^>]*borderFillIDRef="(\d+)"/.exec(section)![1]);
    expect(borderFillOf(header, ref)).toContain('color="#E5E7EB"');
  });

  it("배경만 있는 td(테두리 명시 없음)는 무테 + 채우기 (docx-convert 미러링, 격자 미생성)", async () => {
    const { header, section } = await hs(
      `<table><tr><td style="background-color: rgb(0,0,255)">x</td></tr></table>`
    );
    const ref = Number(/<hp:tc[^>]*borderFillIDRef="(\d+)"/.exec(section)![1]);
    const bf = borderFillOf(header, ref);
    expect(bf).toContain('<hh:leftBorder type="NONE"'); // border CSS 없음 → 무테
    expect(bf).not.toContain('<hh:leftBorder type="SOLID"'); // 격자 없음
    expect(bf).toContain('faceColor="#0000FF"'); // 채우기는 유지
  });
});

describe("HTML <table> 무테 셀 기본 격자 제거 (docx-convert 미러링, hwp-convert-aio)", () => {
  it("border CSS 없는 <table> → tbl·모든 셀 borderFillIDRef=1 (무테)", async () => {
    const sec = await sectionOf(`<table><tr><td>A</td><td>B</td></tr></table>`);
    expect(sec).toMatch(/<hp:tbl[^>]*borderFillIDRef="1"/);
    const refs = [...sec.matchAll(/<hp:tc[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    expect(refs.length).toBe(2);
    expect(refs.every((r) => r === 1)).toBe(true);
  });

  it("F-01 회귀: 표레벨 전용 border(<table style=border>) → tbl borderFillIDRef=2 유지(무테화 안 됨)", async () => {
    const sec = await sectionOf(
      `<table style="border:1px solid rgb(0,0,0)"><tr><td>x</td></tr></table>`
    );
    expect(sec).toMatch(/<hp:tbl[^>]*borderFillIDRef="2"/);
  });

  it("mixed-cell: border 있는 셀은 보존, 없는 셀은 무테(1)", async () => {
    const { header, section } = await hs(
      `<table><tr><td style="border-right:1px solid rgb(0,0,0)">A</td><td>B</td></tr></table>`
    );
    const refs = [...section.matchAll(/<hp:tc[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    expect(refs.length).toBe(2);
    expect(refs[0]).toBeGreaterThanOrEqual(3); // border 있는 셀 = 커스텀 borderFill
    expect(borderFillOf(header, refs[0])).toContain('<hh:rightBorder type="SOLID"');
    expect(refs[1]).toBe(1); // border 없는 셀 = 무테
  });
});

describe("div↔table 변환 동등성 — 셀 테두리만 비교 (배경/정렬 책임 차이는 비교 대상 외)", () => {
  // 셀의 4면 border type 만 추출(채우기·정렬 등은 의도적으로 비교하지 않음 — F-02).
  const cellBorderTypes = (header: string, section: string): string[][] => {
    const refs = [...section.matchAll(/<hp:tc[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    return refs.map((r) => {
      if (r === 1) return ["NONE", "NONE", "NONE", "NONE"]; // 예약 id1 = 무테
      const bf = borderFillOf(header, r);
      return [...bf.matchAll(/<hh:(?:left|right|top|bottom)Border type="(\w+)"/g)].map((m) => m[1]);
    });
  };

  it("무테 등가: grid div 2칸 == <table> 1행2열 → 양쪽 셀 테두리 NONE", async () => {
    const div = await hs(
      `<div style="display:grid; grid-template-columns:50px 50px"><div>A</div><div>B</div></div>`
    );
    const tbl = await hs(`<table><tr><td>A</td><td>B</td></tr></table>`);
    const dt = cellBorderTypes(div.header, div.section);
    const tt = cellBorderTypes(tbl.header, tbl.section);
    expect(dt).toEqual(tt);
    expect(dt.flat().every((t) => t === "NONE")).toBe(true);
  });

  it("명시 border 등가: 동일 border CSS → 양쪽 셀 테두리 SOLID·동색", async () => {
    const css = "border:1px solid rgb(0,0,0)";
    const div = await hs(
      `<div style="display:grid; grid-template-columns:50px 50px"><div style="${css}">A</div><div style="${css}">B</div></div>`
    );
    const tbl = await hs(`<table><tr><td style="${css}">A</td><td style="${css}">B</td></tr></table>`);
    const dRef = Number(/<hp:tc[^>]*borderFillIDRef="(\d+)"/.exec(div.section)![1]);
    const tRef = Number(/<hp:tc[^>]*borderFillIDRef="(\d+)"/.exec(tbl.section)![1]);
    const dBf = borderFillOf(div.header, dRef);
    const tBf = borderFillOf(tbl.header, tRef);
    // 4면 type 일치
    const types = (bf: string) =>
      [...bf.matchAll(/<hh:(?:left|right|top|bottom)Border type="(\w+)"/g)].map((m) => m[1]);
    expect(types(dBf)).toEqual(types(tBf));
    expect(types(dBf).every((t) => t === "SOLID")).toBe(true);
    // 색 일치
    const color = (bf: string) => /<hh:leftBorder[^>]*color="(#[0-9A-F]+)"/.exec(bf)?.[1];
    expect(color(dBf)).toBe(color(tBf));
  });
});

describe("HTML 레이아웃 마감 — padding / gap / vertical-align", () => {
  it("padding:9px → 셀 cellMargin 675(=9*75 HWPUNIT)", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns:100px 100px"><div style="padding:9px">A</div><div>B</div></div>`
    );
    expect(sec).toContain('<hp:cellMargin left="675" right="675" top="675" bottom="675"/>');
  });

  it("padding 단축 2값(세로 가로)도 면별로 반영", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns:100px 100px"><div style="padding:6px 9px">A</div><div>B</div></div>`
    );
    // top/bottom=6px(450), left/right=9px(675)
    expect(sec).toContain('<hp:cellMargin left="675" right="675" top="450" bottom="450"/>');
  });

  it("grid gap:9px → 표 cellSpacing 675", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns:100px 100px; gap:9px"><div>A</div><div>B</div></div>`
    );
    expect(sec).toMatch(/<hp:tbl[^>]*cellSpacing="675"/);
  });

  it("레이아웃 셀 기본 세로정렬 TOP (H-02)", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns:50px 50px"><div>A</div><div>B</div></div>`
    );
    expect(sec).toMatch(/vertAlign="TOP"/);
    expect(sec).not.toMatch(/vertAlign="CENTER"/);
  });

  it("데이터 표 td padding/vertical-align 반영", async () => {
    const sec = await sectionOf(
      `<table><tr><td style="padding:4.5px; vertical-align:bottom">x</td></tr></table>`
    );
    expect(sec).toContain('<hp:cellMargin left="338" right="338" top="338" bottom="338"/>'); // 4.5*75=337.5→338
    expect(sec).toMatch(/vertAlign="BOTTOM"/);
  });

  it("무회귀: 마감 미지정 데이터 표는 기존 리터럴 유지(cellMargin 510/141, vertAlign CENTER, cellSpacing 0)", async () => {
    const sec = await sectionOf(`<table><tr><td>x</td></tr></table>`);
    expect(sec).toContain('<hp:cellMargin left="510" right="510" top="141" bottom="141"/>');
    expect(sec).toMatch(/vertAlign="CENTER"/);
    expect(sec).toMatch(/<hp:tbl[^>]*cellSpacing="0"/);
  });
});

describe("도장박스 — inline span border → char 테두리 (#4)", () => {
  it("빈 bordered span → run charShape 테두리(borderFillIDRef≥3) + 문단 보존", async () => {
    const { header, section } = await hs(`<span style="border:1px solid rgb(209,213,220)"></span>`);
    const refs = [...header.matchAll(/<hh:charPr[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    const bordered = refs.find((r) => r >= 3);
    expect(bordered).toBeDefined(); // 테두리 있는 charPr 존재(빈 문단 필터에 안 지워짐)
    const bf = borderFillOf(header, bordered!);
    expect(bf).toContain('<hh:leftBorder type="SOLID"');
    expect(bf).toContain('color="#D1D5DC"');
    expect(section).toContain("　"); // placeholder(전각공백) run 보존
  });

  it("텍스트 있는 bordered span → 그 run charPr 에 테두리", async () => {
    const { header } = await hs(`<p><span style="border:1px solid rgb(0,0,0)">인</span></p>`);
    const refs = [...header.matchAll(/<hh:charPr[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    expect(refs.some((r) => r >= 3)).toBe(true);
  });

  it("무회귀: 테두리 없는 일반 텍스트는 charPr borderFillIDRef=1 유지", async () => {
    const { header } = await hs(`<p>일반 텍스트</p>`);
    const refs = [...header.matchAll(/<hh:charPr[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    expect(refs.every((r) => r === 1)).toBe(true);
  });
});

describe("인라인 width span flex 행 → 무테 표 승격 (hwp-convert-kmz)", () => {
  // 발주서 '발주자' 줄: flex-col(items-end) > flex-row > [라벨 | 값 | 도장칸(빈 bordered span)]
  const orderRow =
    `<div style="display:flex; flex-direction:column; align-items:flex-end; gap:6.75px">` +
    `<div style="display:flex; flex-direction:row; align-items:center; gap:9px">` +
    `<span style="width:47.7708px"><strong>발주자</strong></span>` +
    `<span style="width:108px">테스트 (인)</span>` +
    `<span aria-hidden="true" style="width:40.5px; border:0.666667px solid rgb(209,213,220)"></span>` +
    `</div></div>`;

  it("발주자 행 → 1행 3열 무테 표(라벨|값|도장칸), 텍스트·colCnt 보존", async () => {
    const sec = await sectionOf(orderRow);
    expect(tblCount(sec)).toBe(1);
    expect(sec).toMatch(/rowCnt="1" colCnt="3"/);
    expect(sec).toMatch(/<hp:tbl[^>]*borderFillIDRef="1"/); // 무테
    expect(sec).toContain("발주자");
    expect(sec).toContain("테스트 (인)");
  });

  it("도장칸(빈 bordered span)은 placeholder 없이 정사각 테두리 셀 (PR-01)", async () => {
    const { header, section } = await hs(orderRow);
    const refs = [...section.matchAll(/<hp:tc[^>]*borderFillIDRef="(\d+)"/g)].map((m) => Number(m[1]));
    expect(refs.length).toBe(3);
    expect(refs[0]).toBe(1); // 라벨 무테
    expect(refs[1]).toBe(1); // 값 무테
    expect(refs[2]).toBeGreaterThanOrEqual(3); // 도장칸 = 테두리 셀
    expect(borderFillOf(header, refs[2])).toContain('<hh:leftBorder type="SOLID"');
    expect(section).not.toContain("　"); // walkInline placeholder(전각공백) 미주입 — 셀 자체가 박스
  });

  it("우측정렬: align-items:flex-end → 표 감싼 문단 alignment=RIGHT", async () => {
    const { header, section } = await hs(orderRow);
    const pid = /paraPrIDRef="(\d+)"[^>]*>\s*<hp:run[^>]*>\s*<hp:tbl/.exec(section)?.[1];
    expect(pid).toBeDefined();
    const pp = new RegExp(`<hh:paraPr id="${pid}"[\\s\\S]*?</hh:paraPr>`).exec(header)?.[0] ?? "";
    expect(pp).toMatch(/<hh:align[^>]*horizontal="RIGHT"/);
  });

  it("fitContent: 전폭<42520, 값/도장칸 width 보존 + 라벨 콘텐츠 최소폭 + 레이아웃 셀 lineWrap=KEEP", async () => {
    const sec = await sectionOf(orderRow);
    expect(sec).toMatch(/lineWrap="KEEP"/); // 레이아웃 셀 줄바꿈 금지(굵은 라벨 세로깨짐 방지)
    const total = Number(/<hp:sz width="(\d+)"/.exec(sec)![1]);
    expect(total).toBeLessThan(42520); // 콘텐츠 폭 표(우측정렬 실효)
    const cs = [...sec.matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => Number(m[1]));
    expect(cs.length).toBe(3);
    // 발주자 라벨: 디자인폭(47.77px=3583) 이상 — 굵은 3자 겹침 방지로 콘텐츠 최소폭까지 확장됨.
    expect(cs[0]).toBeGreaterThanOrEqual(3583);
    expect(cs[0]).toBeLessThan(8100);
    expect(cs[1]).toBe(8100); // 값(108px): 콘텐츠 < 디자인 → 디자인폭 보존
    expect(cs[2]).toBe(3038); // 도장칸(40.5px) 보존
  });

  it("칸 정렬: width만(90/200, border 0) → 2열 표, 셀폭 비 보존 (기존 NEGATIVE와 차이=width 유무)", async () => {
    const sec = await sectionOf(
      `<div style="display:flex; flex-direction:row"><span style="width:90px">상호</span><span style="width:200px">테스트</span></div>`
    );
    expect(tblCount(sec)).toBe(1);
    expect(sec).toMatch(/colCnt="2"/);
    const cs = [...sec.matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => Number(m[1]));
    expect(cs).toEqual([6750, 15000]);
  });

  it("무회귀: width·border 없는 span flex-row 는 표 안 됨", async () => {
    const sec = await sectionOf(
      `<div style="display:flex; flex-direction:row"><span>상호</span><span>테스트</span></div>`
    );
    expect(tblCount(sec)).toBe(0);
  });

  it("무회귀(PR-02): 기존 grid 레이아웃 표(fitContent 미설정)는 전폭 42520 유지", async () => {
    const sec = await sectionOf(
      `<div style="display:grid; grid-template-columns:300px 100px"><div>A</div><div>B</div></div>`
    );
    const cs = [...sec.matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => Number(m[1]));
    expect(cs.reduce((a, b) => a + b, 0)).toBe(42520);
  });

  it("무회귀: 개행/들여쓰기 섞인 flex 행도 승격(loose-text 오판 방지)", async () => {
    const sec = await sectionOf(
      `<div style="display:flex; flex-direction:row; gap:9px">\n  <span style="width:90px">상호</span>\n  <span style="width:200px">테스트</span>\n</div>`
    );
    expect(tblCount(sec)).toBe(1);
    expect(sec).toMatch(/colCnt="2"/);
  });

  // F-02(Codex plan-review) 가드: 무테표(fitContent) 셀 문단도 buildParagraphXml 을 거친다.
  // lineseg 분기(fitsOneLine) 도입 후, 짧은 셀 라벨은 1줄에 들어가므로 linesegarray 가 유지되어야
  // 셀 채우기/높이 박스가 글자를 감싼다(긴 본문 생략 분기와 양립).
  it("F-02: flex width-span 무테표 셀(짧은 라벨)은 linesegarray 유지", async () => {
    const sec = await sectionOf(
      `<div style="display:flex; flex-direction:row"><span style="width:90px">상호</span><span style="width:200px">테스트</span></div>`
    );
    expect(tblCount(sec)).toBe(1);
    // 셀 내부 문단의 linesegarray 가 살아있다(짧은 라벨 = 1줄 → fitsOneLine).
    const tbl = /<hp:tbl[\s\S]*?<\/hp:tbl>/.exec(sec)![0];
    expect(tbl).toMatch(/<hp:linesegarray>/);
    // 무테(borderFillIDRef=1) 표 구조 무회귀.
    expect(sec).toMatch(/<hp:tbl[^>]*borderFillIDRef="1"/);
  });
});
