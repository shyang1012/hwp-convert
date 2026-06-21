/**
 * j1s — 이미지 원본 비율 + CSS width/height 반영.
 * imagePixelSize(헤더 px 파싱) + buildPicXml(비율 보존 크기).
 * [shyang 2026-06-21]
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { htmlToHwpx } from "../src/lib/hwp/index.js";
import { imagePixelSize } from "../src/lib/hwp/binData.js";

function u8(...b: number[]): Uint8Array {
  return Uint8Array.from(b);
}
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const le32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

function fakePng(w: number, h: number): Uint8Array {
  return u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ...be32(w), ...be32(h), 8, 6, 0, 0, 0);
}
function pngDataUri(w: number, h: number): string {
  return `data:image/png;base64,${Buffer.from(fakePng(w, h)).toString("base64")}`;
}

async function sectionOf(html: string): Promise<string> {
  const zip = await JSZip.loadAsync(await htmlToHwpx(html));
  return await zip.file("Contents/section0.xml")!.async("string");
}

describe("imagePixelSize — 헤더 px 파싱", () => {
  it("PNG IHDR (1903×957)", () => {
    expect(imagePixelSize(fakePng(1903, 957))).toEqual({ w: 1903, h: 957 });
  });

  it("JPEG SOF0 (200×100)", () => {
    // FFD8 SOI, FFC0 SOF0, len, precision, height, width
    const jpg = u8(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, ...be16(100), ...be16(200), 0x03);
    expect(imagePixelSize(jpg)).toEqual({ w: 200, h: 100 });
  });

  it("JPEG: SOF 전 APP0/RST 마커 스킵 후 dims", () => {
    const jpg = u8(
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x11, 0x22, // APP0 len=4 (payload 2)
      0xff, 0xd0, // RST0 (no length)
      0xff, 0xc2, 0x00, 0x11, 0x08, ...be16(150), ...be16(300), 0x03 // SOF2
    );
    expect(imagePixelSize(jpg)).toEqual({ w: 300, h: 150 });
  });

  it("GIF89a (300×150 LE)", () => {
    const gif = u8(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(300), ...le16(150));
    expect(imagePixelSize(gif)).toEqual({ w: 300, h: 150 });
  });

  it("BMP (120×80 LE @18/22)", () => {
    const bmp = u8(0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x28, 0, 0, 0,
      ...le32(120), ...le32(80));
    expect(imagePixelSize(bmp)).toEqual({ w: 120, h: 80 });
  });

  it("깨진/짧은 버퍼 → null (무한루프·오버런 없음)", () => {
    expect(imagePixelSize(u8(0xff, 0xd8, 0xff))).toBeNull(); // truncated JPEG
    expect(imagePixelSize(u8(1, 2, 3))).toBeNull();
    expect(imagePixelSize(u8())).toBeNull();
  });
});

describe("buildPicXml — 비율/CSS 크기", () => {
  it("CSS 없음 → 원본 px 비율(200×100=2:1), 페이지폭 내라 px*75", async () => {
    const sec = await sectionOf(`<img src="${pngDataUri(200, 100)}">`);
    expect(sec).toContain('<hp:sz width="15000" widthRelTo="ABSOLUTE" height="7500"');
  });

  it("width:70% → 페이지 본문폭 70% + 원본 비율로 높이", async () => {
    // 0.7*42520=29764, 높이=29764*100/200=14882
    const sec = await sectionOf(`<img src="${pngDataUri(200, 100)}" style="width:70%">`);
    expect(sec).toMatch(/<hp:sz width="29764" widthRelTo="ABSOLUTE" height="14882"/);
  });

  it("width:200px → 200*75=15000 + 비율 높이 7500", async () => {
    const sec = await sectionOf(`<img src="${pngDataUri(400, 200)}" style="width:200px">`);
    expect(sec).toContain('<hp:sz width="15000" widthRelTo="ABSOLUTE" height="7500"');
  });

  it("폴백: 헤더 불명 → 기존 40000×30000", async () => {
    // 1바이트 데이터(헤더 파싱 불가)
    const bad = `data:image/png;base64,${Buffer.from(u8(1)).toString("base64")}`;
    const sec = await sectionOf(`<img src="${bad}">`);
    expect(sec).toContain('<hp:sz width="40000" widthRelTo="ABSOLUTE" height="30000"');
  });
});
