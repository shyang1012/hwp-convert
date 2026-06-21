/**
 * BinData (CFB Storage) 에서 임베디드 이미지/OLE 데이터 추출.
 *
 * /BinData/BIN0001.png, BIN0002.jpg, ... 패턴.
 * DocInfo의 BIN_DATA 레코드와 storageId 로 연결됨.
 *
 * 원작: rhwp/src/parser/bin_data.rs (MIT, Edward Kim)
 */

import type { HwpCfbReader } from "./cfbReader.js";
import type { HwpBinDataRef } from "./types.js";

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function loadBinDataContent(
  cfb: HwpCfbReader,
  refs: HwpBinDataRef[]
): Map<number, { data: Uint8Array; extension: string }> {
  const out = new Map<number, { data: Uint8Array; extension: string }>();

  for (const ref of refs) {
    if (ref.type === "link") continue;
    const isStorage = ref.type === "storage";
    const ext = ref.extension ?? (isStorage ? "OLE" : "dat");

    // 파일명: BIN{XXXX}.{ext} (4자리 hex, 대문자/소문자 둘 다 시도)
    const idHex = ref.storageId.toString(16).padStart(4, "0");
    const candidates = [
      `/BinData/BIN${idHex.toUpperCase()}.${ext}`,
      `/BinData/BIN${idHex.toLowerCase()}.${ext}`,
    ];

    let bytes: Uint8Array | null = null;
    for (const path of candidates) {
      bytes = cfb.readBinData(path);
      if (bytes) break;
    }
    if (!bytes) continue;

    // OLE Storage 의 경우 선두 4바이트 size prefix 가 붙는 경우가 있어 정리
    if (isStorage && bytes.byteLength > 12) {
      const headIsCfb =
        bytes[0] === CFB_MAGIC[0] &&
        bytes[1] === CFB_MAGIC[1] &&
        bytes[2] === CFB_MAGIC[2] &&
        bytes[3] === CFB_MAGIC[3];
      const cfbAt4 =
        bytes[4] === CFB_MAGIC[0] &&
        bytes[5] === CFB_MAGIC[1] &&
        bytes[6] === CFB_MAGIC[2] &&
        bytes[7] === CFB_MAGIC[3];
      if (!headIsCfb && cfbAt4) {
        bytes = bytes.subarray(4);
      }
    }

    out.set(ref.storageId, { data: new Uint8Array(bytes), extension: ext });
  }

  return out;
}

export function detectImageMime(extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return "application/octet-stream";
}

/**
 * 이미지 바이트의 시그니처(magic)로 포맷을 판별하고 헤더에서 원본 px 를 읽는다.
 * PNG/JPEG/GIF/BMP 지원. 못 읽으면 null. 모든 접근은 바운드 체크(무한루프·오버런 차단).
 */
export function imagePixelSize(data: Uint8Array): { w: number; h: number } | null {
  const d = data;
  const n = d.length;
  const u16be = (p: number): number => (d[p] << 8) | d[p + 1];
  const u32be = (p: number): number => (d[p] * 0x1000000) + (d[p + 1] << 16) + (d[p + 2] << 8) + d[p + 3];
  const u16le = (p: number): number => d[p] | (d[p + 1] << 8);
  const u32le = (p: number): number => d[p] + (d[p + 1] << 8) + (d[p + 2] << 16) + d[p + 3] * 0x1000000;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR(width@16 height@20, BE u32)
  if (n >= 24 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) {
    const w = u32be(16);
    const h = u32be(20);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  // GIF: "GIF8", width@6 height@8 (LE u16)
  if (n >= 10 && d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x38) {
    const w = u16le(6);
    const h = u16le(8);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  // BMP: "BM", width@18 height@22 (LE, height 음수 가능 → 절대값)
  if (n >= 26 && d[0] === 0x42 && d[1] === 0x4d) {
    const w = u32le(18);
    const h = Math.abs(u32le(22) | 0);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  // JPEG: FF D8 ... 마커 스캔
  if (n >= 4 && d[0] === 0xff && d[1] === 0xd8) {
    let p = 2;
    while (p + 1 < n) {
      if (d[p] !== 0xff) {
        p++;
        continue;
      } // 0xFF 정렬 탐색
      let m = d[p + 1];
      // 0xFF 패딩 연속 skip
      let q = p + 1;
      while (q < n && d[q] === 0xff) q++;
      if (q >= n) return null;
      m = d[q];
      p = q - 1; // p+1 = q
      if (m === 0xd8 || m === 0xd9) {
        p += 2;
        continue;
      } // SOI/EOI: 길이 없음
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        p += 2;
        continue;
      } // TEM/RST: 길이 없음
      if (m === 0xda) return null; // SOS: 이미지 데이터 시작, dims 못 찾음
      if (p + 4 >= n) return null;
      const len = u16be(p + 2);
      if (len < 2) return null;
      // SOF0~15 (C4=DHT, C8=JPG, CC=DAC 제외)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (p + 9 > n) return null;
        const h = u16be(p + 5);
        const w = u16be(p + 7);
        return w > 0 && h > 0 ? { w, h } : null;
      }
      const next = p + 2 + len;
      if (next <= p) return null; // 미전진 방어
      p = next;
    }
    return null;
  }
  return null;
}
