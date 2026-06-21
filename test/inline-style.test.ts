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

describe("html inline style 보존", () => {
  it("color: rgb(...) → charShape textColor", async () => {
    const h = await headerOf(`<p style="color: rgb(255, 0, 0)">빨강</p>`);
    expect(h).toMatch(/textColor="#FF0000"/);
  });

  it("color: #hex → charShape textColor", async () => {
    const h = await headerOf(`<p style="color:#1A5276">남색</p>`);
    expect(h).toMatch(/textColor="#1A5276"/i);
  });

  it("background-color → charShape shadeColor", async () => {
    const h = await headerOf(`<p style="background-color: rgb(0, 0, 255)">파란배경</p>`);
    expect(h).toMatch(/shadeColor="#0000FF"/);
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

  it("표 셀(td)의 inline style 색상도 보존", async () => {
    const h = await headerOf(
      `<table><tr><td style="color: rgb(255,0,0); background-color: rgb(0,0,255)">셀</td></tr></table>`
    );
    expect(h).toMatch(/textColor="#FF0000"/);
    expect(h).toMatch(/shadeColor="#0000FF"/);
  });

  it("중첩 div 안 텍스트의 색상 상속", async () => {
    const h = await headerOf(`<div style="color: rgb(26,82,118)"><span>중첩</span></div>`);
    expect(h).toMatch(/textColor="#1A5276"/i);
  });
});
