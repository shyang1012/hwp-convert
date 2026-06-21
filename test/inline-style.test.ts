/**
 * html inline style(color / background-color / font-size / text-align) 보존.
 * htmlReader 가 style 속성을 파싱해 charShape(색·크기) / paraShape(정렬) 로 매핑.
 * [shyang 2026-06-21]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpx } from "../src/lib/hwp/index.js";

async function headerOf(html: string): Promise<string> {
  const zip = await JSZip.loadAsync(await htmlToHwpx(html));
  return await zip.file("Contents/header.xml")!.async("string");
}

async function bothOf(html: string): Promise<{ header: string; section: string }> {
  const zip = await JSZip.loadAsync(await htmlToHwpx(html));
  return {
    header: await zip.file("Contents/header.xml")!.async("string"),
    section: await zip.file("Contents/section0.xml")!.async("string"),
  };
}

describe("html inline style 보존", () => {
  it("color: rgb(...) → charShape textColor", async () => {
    const h = await headerOf(`<p style="color: rgb(255, 0, 0)">빨강</p>`);
    expect(h).toMatch(/textColor="#FF0000"/);
  });

  it("color: #hex → charShape textColor", async () => {
    const h = await headerOf(`<p style="color:#1A5276">남색</p>`);
    expect(h).toMatch(/textColor="#1A5276"/i);
  });

  it("블록 <p> background-color → 문단 borderFill 채우기 (글자 음영 아님)", async () => {
    // igp: 블록 레벨 배경은 글자 단위 shadeColor 가 아니라 문단 전체 채우기 박스여야 한다.
    const h = await headerOf(`<p style="background-color: rgb(0, 0, 255)">파란배경</p>`);
    expect(h).toMatch(/<hc:fillBrush><hc:winBrush faceColor="#0000FF"/);
    expect(h).toMatch(/<hh:paraPr[^>]*borderFillIDRef="[1-9]/);
    expect(h).not.toMatch(/shadeColor="#0000FF"/);
  });

  it("인라인 <span> background-color → 글자 음영 shadeColor 유지", async () => {
    // 인라인 배경은 종전대로 글자 음영(문단 박스 아님).
    const h = await headerOf(`<p><span style="background-color: rgb(0, 0, 255)">음영</span></p>`);
    expect(h).toMatch(/shadeColor="#0000FF"/);
  });

  it("제목 div 남색 배경 → 문단 박스 borderFill (테두리 NONE + 남색 채우기)", async () => {
    const h = await headerOf(`<div style="background-color: rgb(26,82,118)"><strong>발주서</strong></div>`);
    expect(h).toMatch(/faceColor="#1A5276"/i);
    expect(h).toMatch(/<hh:paraPr[^>]*borderFillIDRef="[1-9]/);
  });

  it("font-size: 20px → charShape height(1500 = 15pt)", async () => {
    const h = await headerOf(`<p style="font-size: 20px">큰글자</p>`);
    expect(h).toMatch(/height="1500"/);
  });

  it("text-align: center → paraShape 정렬 CENTER", async () => {
    const h = await headerOf(`<p style="text-align: center">가운데</p>`);
    expect(h).toMatch(/horizontal="CENTER"/);
  });

  it("text-align: right → paraShape 정렬 RIGHT", async () => {
    const h = await headerOf(`<p style="text-align: right">오른쪽</p>`);
    expect(h).toMatch(/horizontal="RIGHT"/);
  });

  it("표 셀(td)의 inline style: 글자색 보존 + 배경은 셀 borderFill 채우기", async () => {
    const { header, section } = await bothOf(
      `<table><tr><td style="color: rgb(255,0,0); background-color: rgb(0,0,255)">셀</td></tr></table>`
    );
    expect(header).toMatch(/textColor="#FF0000"/); // 글자색 상속 유지
    expect(header).toMatch(/faceColor="#0000FF"/); // 셀 배경 채우기
    expect(section).toMatch(/<hp:tc[^>]*borderFillIDRef="[1-9]/); // 셀이 색 채우기 borderFill 참조
  });

  it("중첩 div 안 텍스트의 색상 상속", async () => {
    const h = await headerOf(`<div style="color: rgb(26,82,118)"><span>중첩</span></div>`);
    expect(h).toMatch(/textColor="#1A5276"/i);
  });
});
