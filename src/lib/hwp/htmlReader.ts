/**
 * HTML → HwpDocument IR.
 *
 * `htmlparser2` 로 SAX 파싱 → 트리 구축 → IR 변환.
 *   - p, div, h1~h6 → paragraph (heading 은 굵게 + 큰 사이즈)
 *   - strong/b, em/i → 굵게/기울임 run
 *   - br → 줄바꿈
 *   - ul/ol/li → "- " / "1. " prefix paragraph
 *   - table/thead/tbody/tr/th/td → HwpTableControl
 *   - img → HwpPictureControl (src 가 data: URI 일 때만)
 *   - blockquote → "> " prefix paragraph
 *   - code/pre → 모노스페이스
 *   - a → 텍스트만 (URL 미보존)
 *   - 기타 (style/script/head 등) → 무시
 */

import { Parser } from "htmlparser2";
import type {
  HwpDocument,
  HwpParagraph,
  HwpRun,
  HwpControl,
  HwpTableCell,
  HwpCharShape,
  HwpParaShape,
  HwpBorderFill,
  HwpBorderLine,
  HwpStyle,
  HwpFaceName,
  HwpPageDef,
  ImageResolver,
  ConvertOptions,
  PageSetupOption,
  PaperSizeName,
} from "./types.js";

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlNode | string)[];
  parent: HtmlNode | null;
}

function parseToTree(html: string): { root: HtmlNode; styleText: string } {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let current: HtmlNode = root;
  const voidTags = new Set([
    "br", "img", "hr", "input", "meta", "link", "source", "track", "wbr", "col", "area", "base", "embed",
  ]);
  const skipTags = new Set(["script", "style", "head", "noscript", "template"]);
  let inSkippedTag = 0;
  // <style> 텍스트는 본문 트리에선 제외하되 @page 파싱용으로 따로 모은다(wku). depth>0 이면 style 내부.
  let inStyle = 0;
  const styleChunks: string[] = [];

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "style") inStyle++;
        if (skipTags.has(name)) {
          inSkippedTag++;
          return;
        }
        if (inSkippedTag > 0) return;
        const node: HtmlNode = { tag: name, attrs, children: [], parent: current };
        current.children.push(node);
        if (!voidTags.has(name)) current = node;
      },
      ontext(text) {
        if (inStyle > 0) styleChunks.push(text);
        if (inSkippedTag > 0) return;
        current.children.push(text);
      },
      onclosetag(name) {
        if (name === "style") inStyle = Math.max(0, inStyle - 1);
        if (skipTags.has(name)) {
          inSkippedTag = Math.max(0, inSkippedTag - 1);
          return;
        }
        if (inSkippedTag > 0) return;
        if (voidTags.has(name)) return;
        if (current.tag === name && current.parent) {
          current = current.parent;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true }
  );
  parser.write(html);
  parser.end();
  return { root, styleText: styleChunks.join("") };
}

interface BuildContext {
  charShapeIds: Map<string, number>;
  binData: Map<number, { data: Uint8Array; extension: string }>;
  nextBinDataId: number;
  imageResolver?: ImageResolver;
  // 동적 등록 대상 (색상/크기 charShape, 정렬 paraShape)
  charShapes: HwpCharShape[];
  paraShapes: HwpParaShape[];
  paraShapeIds: Map<string, number>;
  // 블록/셀 배경 채우기 borderFill (id 0 = 기본, 색 채우기는 1+)
  borderFills: HwpBorderFill[];
  borderFillIds: Map<string, number>;
}

interface ShapeIds {
  idDefault: number;
  idBold: number;
  idItalic: number;
  idBoldItalic: number;
  idMono: number;
  idH1: number;
  idH2: number;
  idH3: number;
  idHmin: number;
}

interface InlineState {
  bold: boolean;
  italic: boolean;
  mono: boolean;
  textColor?: number; // HWP ColorRef (0xBBGGRR), undefined = 기본 검정
  shadeColor?: number; // 배경색
  baseSize?: number; // 글자 크기 (HWPUNIT, 1000 = 10pt)
  borderFillId?: number; // 인라인 span border → 글자 테두리(docInfo.borderFills 인덱스)
  inheritAlign?: HwpParaShape["alignment"]; // 부모 flex/grid 컨테이너의 가로축 정렬(직접 자식 1단계만)
}

/** 인라인 style 속성에서 색/크기/정렬을 파싱. */
interface ParsedStyle {
  textColor?: number;
  shadeColor?: number;
  baseSize?: number;
  align?: HwpParaShape["alignment"];
  vAlign?: "TOP" | "CENTER" | "BOTTOM";
}

/** CSS px → HWPUNIT (1/7200 인치): 1px(1/96 인치) = 75 HWPUNIT. */
function pxToHwpUnit(px: number): number {
  return Math.round(px * 75);
}

function parseColorToHwp(v: string): number | undefined {
  const s = v.trim().toLowerCase();
  let r: number, g: number, b: number;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (rgb) {
    r = +rgb[1]; g = +rgb[2]; b = +rgb[3];
  } else {
    const hex = /^#([0-9a-f]{6})$/.exec(s) || /^#([0-9a-f]{3})$/.exec(s);
    if (!hex) return undefined;
    const h = hex[1].length === 3 ? hex[1].replace(/(.)/g, "$1$1") : hex[1];
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  // HWP ColorRef = 0xBBGGRR (colorBgrToHex 와 정합)
  return (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16);
}

function parseInlineStyle(style: string | undefined): ParsedStyle {
  const out: ParsedStyle = {};
  if (!style) return out;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (prop === "color") out.textColor = parseColorToHwp(val);
    else if (prop === "background-color" || prop === "background") {
      const c = parseColorToHwp(val);
      // 흰색 배경은 shade 없음으로 처리 (builder 가 none 출력)
      if (c !== undefined && c !== 0xffffff) out.shadeColor = c;
    } else if (prop === "font-size") {
      const px = /([\d.]+)px/.exec(val);
      const pt = /([\d.]+)pt/.exec(val);
      if (px) out.baseSize = Math.round(parseFloat(px[1]) * 75); // px→pt(*0.75)→HWPUNIT(*100)
      else if (pt) out.baseSize = Math.round(parseFloat(pt[1]) * 100);
    } else if (prop === "text-align") {
      const a = val.toLowerCase();
      if (a === "left") out.align = "left";
      else if (a === "right") out.align = "right";
      else if (a === "center") out.align = "center";
      else if (a === "justify") out.align = "justify";
    } else if (prop === "vertical-align") {
      const v = val.toLowerCase();
      if (v === "top") out.vAlign = "TOP";
      else if (v === "middle") out.vAlign = "CENTER";
      else if (v === "bottom") out.vAlign = "BOTTOM";
      // baseline/sub/super 등은 미설정(빌더 기본)
    }
  }
  return out;
}

/** CSS padding(단축 1~4값 / padding-{side}) → 면별 HWPUNIT. 미지정 면은 undefined(0 폴백 안 함). */
function parsePaddingSides(
  style: string | undefined
): { left?: number; right?: number; top?: number; bottom?: number } {
  const out: { left?: number; right?: number; top?: number; bottom?: number } = {};
  if (!style) return out;
  const px = (v: string): number | undefined => {
    const m = /^([\d.]+)px$/.exec(v.trim());
    if (m) return pxToHwpUnit(parseFloat(m[1]));
    return /^0$/.test(v.trim()) ? 0 : undefined;
  };
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (prop === "padding") {
      const t = val.split(/\s+/).map(px);
      // CSS 단축: 1값=전면, 2값=세로/가로, 3값=상/가로/하, 4값=상우하좌
      if (t.length === 1) [out.top, out.right, out.bottom, out.left] = [t[0], t[0], t[0], t[0]];
      else if (t.length === 2) [out.top, out.right, out.bottom, out.left] = [t[0], t[1], t[0], t[1]];
      else if (t.length === 3) [out.top, out.right, out.bottom, out.left] = [t[0], t[1], t[2], t[1]];
      else if (t.length >= 4) [out.top, out.right, out.bottom, out.left] = [t[0], t[1], t[2], t[3]];
    } else if (prop === "padding-top") out.top = px(val);
    else if (prop === "padding-right") out.right = px(val);
    else if (prop === "padding-bottom") out.bottom = px(val);
    else if (prop === "padding-left") out.left = px(val);
  }
  return out;
}

/** CSS padding → 4면 HWPUNIT(미지정 면은 0 폴백). 아무 면도 없으면 undefined. */
function parsePadding(
  style: string | undefined
): { left: number; right: number; top: number; bottom: number } | undefined {
  const s = parsePaddingSides(style);
  if (s.top === undefined && s.right === undefined && s.bottom === undefined && s.left === undefined) {
    return undefined;
  }
  return { left: s.left ?? 0, right: s.right ?? 0, top: s.top ?? 0, bottom: s.bottom ?? 0 };
}

/** CSS 가로 다단 컨테이너 판정 결과. */
interface LayoutStyle {
  kind: "grid" | "flexRow";
  /** grid-template-columns 의 컬럼별 px→HWPUNIT(px*75). 비px(fr/auto)은 null. grid 만. */
  templateColsHwp?: (number | null)[];
  /** 칼럼 간격(HWPUNIT) — CSS gap/column-gap 의 컬럼 간격 px → px*75. */
  gapHwp?: number;
}

/** 컨테이너 style 에서 display/flex-direction/grid-template-columns 를 파싱(parseInlineStyle 미파싱 영역). */
function parseLayoutStyle(style: string | undefined): LayoutStyle | null {
  if (!style) return null;
  let display: string | undefined;
  let flexDir: string | undefined;
  let gridCols: string | undefined;
  let gapHwp: number | undefined;
  const colGapPx = (v: string): number | undefined => {
    // gap: <row> <col> (단일이면 양쪽 동일). 칼럼 간격 = 2번째 토큰 ?? 1번째.
    const toks = v.split(/\s+/).filter(Boolean);
    const t = toks[1] ?? toks[0];
    const m = t ? /^([\d.]+)px$/.exec(t) : null;
    return m ? pxToHwpUnit(parseFloat(m[1])) : undefined;
  };
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim().toLowerCase();
    if (prop === "display") display = val;
    else if (prop === "flex-direction") flexDir = val;
    else if (prop === "grid-template-columns") gridCols = val;
    else if (prop === "gap") gapHwp = colGapPx(val);
    else if (prop === "column-gap") gapHwp = colGapPx(val);
  }
  if (display === "grid") {
    const cols = gridCols ? gridCols.split(/\s+/).filter(Boolean) : [];
    if (cols.length < 2) return null; // 다단 아님
    const templateColsHwp = cols.map((c) => {
      const m = /^([\d.]+)px$/.exec(c);
      return m ? Math.round(parseFloat(m[1]) * 75) : null; // px→HWPUNIT, 비px 은 null
    });
    return { kind: "grid", templateColsHwp, gapHwp };
  }
  if (display === "flex" && (flexDir === undefined || flexDir === "row")) {
    return { kind: "flexRow", gapHwp };
  }
  return null;
}

/** CSS 컨테이너의 가로축 정렬을 추출 → "right"|"center"|undefined.
 *  axis 인지: flex-direction:column 이면 가로축=align-items, row(기본)면 가로축=justify-content.
 *  flex-end/end/right→right, center→center, 그 외(flex-start 등)→undefined. flex 컨테이너만. */
function parseCrossAlign(style: string | undefined): "right" | "center" | undefined {
  if (!style) return undefined;
  let display: string | undefined;
  let flexDir: string | undefined;
  let alignItems: string | undefined;
  let justify: string | undefined;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim().toLowerCase();
    if (prop === "display") display = val;
    else if (prop === "flex-direction") flexDir = val;
    else if (prop === "align-items") alignItems = val;
    else if (prop === "justify-content") justify = val;
  }
  if (display !== "flex") return undefined;
  const horiz = flexDir === "column" ? alignItems : justify;
  if (horiz === "flex-end" || horiz === "end" || horiz === "right") return "right";
  if (horiz === "center") return "center";
  return undefined;
}

// HWP 너비 인덱스 → mm (hwpxBuilder.BORDER_WIDTH_MM 와 동일). px→mm 후 최근접 인덱스.
const BORDER_WIDTH_MM_NUM = [
  0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0,
];

function pxToWidthIndex(px: number): number {
  if (!(px > 0)) return 0;
  const mm = (px * 25.4) / 96; // CSS px(96dpi) → mm
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < BORDER_WIDTH_MM_NUM.length; i++) {
    const d = Math.abs(BORDER_WIDTH_MM_NUM[i] - mm);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function styleToLineType(s: string): number {
  switch (s) {
    case "solid":
      return 1;
    case "dashed":
      return 2;
    case "dotted":
      return 3;
    case "double":
      return 8;
    default:
      return 0;
  }
}

interface BorderSpec {
  w?: number;
  s?: string;
  c?: number;
}

/** CSS border(단축/전면/개별 면)를 4면 HwpBorderLine[left,right,top,bottom] + hasBorder 로 파싱. */
function parseBorderStyle(style: string | undefined): {
  borders: [HwpBorderLine, HwpBorderLine, HwpBorderLine, HwpBorderLine];
  hasBorder: boolean;
} {
  const all: BorderSpec = {};
  const sides: Record<"left" | "right" | "top" | "bottom", BorderSpec> = {
    left: {},
    right: {},
    top: {},
    bottom: {},
  };
  const applyShorthand = (o: BorderSpec, val: string): void => {
    for (const tok of val.split(/\s+/).filter(Boolean)) {
      if (/^[\d.]+px$|^0$/.test(tok)) {
        const m = /([\d.]+)px/.exec(tok);
        o.w = m ? parseFloat(m[1]) : 0;
      } else if (/^(solid|dashed|dotted|double|none|hidden)$/i.test(tok)) {
        o.s = tok.toLowerCase();
      } else {
        const c = parseColorToHwp(tok);
        if (c !== undefined) o.c = c;
      }
    }
  };
  if (style) {
    for (const decl of style.split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      const sideM = /^border-(left|right|top|bottom)$/.exec(prop);
      const sidePropM = /^border-(left|right|top|bottom)-(width|style|color)$/.exec(prop);
      if (prop === "border") applyShorthand(all, val);
      else if (sideM) applyShorthand(sides[sideM[1] as keyof typeof sides], val);
      else if (prop === "border-width") {
        const m = /([\d.]+)px/.exec(val);
        all.w = m ? parseFloat(m[1]) : /^0$/.test(val) ? 0 : all.w;
      } else if (prop === "border-style") all.s = val.toLowerCase();
      else if (prop === "border-color") {
        const c = parseColorToHwp(val);
        if (c !== undefined) all.c = c;
      } else if (sidePropM) {
        const o = sides[sidePropM[1] as keyof typeof sides];
        if (sidePropM[2] === "width") {
          const m = /([\d.]+)px/.exec(val);
          o.w = m ? parseFloat(m[1]) : /^0$/.test(val) ? 0 : o.w;
        } else if (sidePropM[2] === "style") o.s = val.toLowerCase();
        else {
          const c = parseColorToHwp(val);
          if (c !== undefined) o.c = c;
        }
      }
    }
  }
  const none = (): HwpBorderLine => ({ lineType: 0, widthIndex: 0, color: 0 });
  const build = (s: BorderSpec): HwpBorderLine => {
    const w = s.w ?? all.w;
    const st = (s.s ?? all.s ?? "").toLowerCase();
    const c = s.c ?? all.c ?? 0;
    if (w === undefined && st === "") return none(); // 면에 아무 지정 없음
    if (w !== undefined && w <= 0) return none(); // 너비 0
    if (st === "none" || st === "hidden") return none();
    const lineType = st === "" ? 1 : styleToLineType(st) || 1; // 스타일 미지정+너비>0 → solid
    return { lineType, widthIndex: pxToWidthIndex(w ?? 1), color: c };
  };
  const borders: [HwpBorderLine, HwpBorderLine, HwpBorderLine, HwpBorderLine] = [
    build(sides.left),
    build(sides.right),
    build(sides.top),
    build(sides.bottom),
  ];
  const hasBorder = borders.some((b) => b.lineType > 0);
  return { borders, hasBorder };
}

// ── 페이지 설정(용지/여백/방향) 도출 — section.pageDef → buildSecPr 로 합류 (p1x·4qp) ──

// 용지 물리 치수(HWPUNIT, 세로 기준). 한글 네이티브 방식: 치수는 물리값 고정, 방향은 landscape
// 플래그로 표현(스왑 안 함). A4 는 buildSecPr 기본값과 동일값 유지(바이트 회귀 방지).
const PAPER_SIZES: Record<PaperSizeName, { width: number; height: number }> = {
  A4: { width: 59528, height: 84186 }, // 210×297 (기존 기본값 보존)
  A3: { width: 84189, height: 119055 }, // 297×420
  A5: { width: 41953, height: 59528 }, // 148×210
  B4: { width: 72850, height: 103181 }, // JIS 257×364
  B5: { width: 51591, height: 72850 }, // JIS 182×257
  Letter: { width: 61200, height: 79200 }, // 8.5×11in
  Legal: { width: 61200, height: 100800 }, // 8.5×14in
};
const A4_SHORT = PAPER_SIZES.A4.width;
// padding/옵션 미지정 시 관습 기본 여백 — buildSecPr 무인자 폴백값과 동일.
const DEFAULT_PAGE_MARGIN = {
  left: 8504,
  right: 8504,
  top: 5668,
  bottom: 4252,
  header: 4252,
  footer: 4252,
  gutter: 0,
};

const PAGE_CONTAINER_TAGS = new Set(["div", "section", "article", "main", "body"]);

/** 의미 있는 엘리먼트 child 만(문자열/공백/주석 제외) 순서 보존. */
function elementChildren(node: HtmlNode): HtmlNode[] {
  return node.children.filter((c): c is HtmlNode => typeof c !== "string");
}

/**
 * 페이지 설정을 읽을 루트 컨테이너 식별 (p1x).
 * 우선순위: html>body 내부 첫 블록 컨테이너 → 없으면 #root 의 첫 블록 컨테이너.
 * 텍스트/공백/주석 노드는 무시하고, 다중 최상위면 첫 블록만 페이지 컨테이너로 본다.
 */
function findPageContainer(root: HtmlNode): HtmlNode | undefined {
  const top = elementChildren(root);
  const html = top.find((n) => n.tag === "html");
  const body =
    top.find((n) => n.tag === "body") ??
    (html ? elementChildren(html).find((n) => n.tag === "body") : undefined);
  const scope = body ? elementChildren(body) : top;
  return scope.find((n) => PAGE_CONTAINER_TAGS.has(n.tag));
}

/**
 * 컨테이너 본문폭 — max-width 우선, 없으면 width. px 만 HWPUNIT 으로 변환.
 * %·auto·calc()·em/rem/vw 등 비px 단위는 undefined(→ 가로 전환 트리거 미발동).
 */
function parseContainerWidthHwp(style: string | undefined): number | undefined {
  if (!style) return undefined;
  let maxW: number | undefined;
  let w: number | undefined;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    const m = /^([\d.]+)px$/.exec(val);
    const v = m ? pxToHwpUnit(parseFloat(m[1])) : undefined;
    if (prop === "max-width") maxW = v;
    else if (prop === "width") w = v;
  }
  return maxW ?? w;
}

/** mm → HWPUNIT(1/7200 inch). 1mm = 7200/25.4 HWPUNIT. */
function mmToHwpUnit(mm: number): number {
  return Math.round((mm * 7200) / 25.4);
}

/**
 * 용지 종류/커스텀 → 물리 치수(HWPUNIT, 세로 기준). 미지정 시 A4.
 * 이름은 PAPER_SIZES 에서, 커스텀 {width,height,unit}은 단위 변환(unit 기본 'mm').
 * 알 수 없는 이름·음수/0 치수는 명시 에러.
 */
function resolvePaperSize(size: PageSetupOption["size"]): { width: number; height: number } {
  if (size === undefined) return { ...PAPER_SIZES.A4 };
  if (typeof size === "string") {
    const found = PAPER_SIZES[size as PaperSizeName];
    if (!found) {
      throw new Error(
        `지원하지 않는 용지 종류: "${size}". 사용 가능: ${Object.keys(PAPER_SIZES).join(", ")} 또는 {width,height,unit} 커스텀.`
      );
    }
    return { ...found };
  }
  const unit = size.unit ?? "mm";
  const conv = (v: number): number => (unit === "mm" ? mmToHwpUnit(v) : Math.round(v));
  const width = conv(size.width);
  const height = conv(size.height);
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`용지 커스텀 치수는 양수여야 합니다: width=${size.width}, height=${size.height} (${unit}).`);
  }
  return { width, height };
}

/** CSS 길이 토큰 → mm. @page margin/size 전용(mm·cm·in·pt·px). 단위 없으면 undefined. */
function cssLenToMm(token: string): number | undefined {
  const t = token.trim();
  if (/^0+(?:\.0+)?$/.test(t)) return 0; // CSS 규격: 0 은 무단위 허용(margin:0 등 흔한 초기화)
  const m = /^([\d.]+)(mm|cm|in|pt|px)$/i.exec(t);
  if (!m) return undefined;
  const v = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case "mm": return v;
    case "cm": return v * 10;
    case "in": return v * 25.4;
    case "pt": return (v * 25.4) / 72;
    case "px": return (v * 25.4) / 96;
  }
  return undefined;
}

/** 용지명 소문자 → 정식 PaperSizeName(@page size 대소문자 무시 매칭). */
const PAPER_NAME_BY_LOWER: Record<string, PaperSizeName> = Object.fromEntries(
  (Object.keys(PAPER_SIZES) as PaperSizeName[]).map((n) => [n.toLowerCase(), n])
);

/**
 * `@page { size; margin }` 규칙 → 부분 PageSetupOption (wku). 셀렉터 없는 bare `@page` 블록을
 * 모두 순회해 병합한다(나중 블록이 같은 속성 덮어씀 = CSS cascade). `@page :first`/named page 같은
 * 셀렉터 변형은 `\s*\{` 가 자연히 스킵(1차 미지원). 인쇄 전용 속성(bleed/marks 등)은 무시.
 * size: 방향 키워드(portrait/landscape) / 용지명 / 두 길이(커스텀 mm). margin: 단축 1~4 + margin-면(mm 환산).
 * 신호 없으면 undefined.
 */
function parseAtPage(css: string): PageSetupOption | undefined {
  if (!css) return undefined;
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ""); // CSS 주석 제거(선언 오파싱 방지)
  const out: PageSetupOption = {};
  const margins: NonNullable<PageSetupOption["margins"]> = {};
  let hasMargin = false;
  const setMargin = (side: keyof typeof margins, mm: number | undefined): void => {
    if (mm !== undefined) {
      margins[side] = mm;
      hasMargin = true;
    }
  };
  const re = /@page\s*\{([^{}]*)\}/gi;
  let block: RegExpExecArray | null;
  let found = false;
  while ((block = re.exec(clean)) !== null) {
    found = true;
    for (const decl of block[1].split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (!val) continue;
      if (prop === "size") {
        const lens: number[] = [];
        for (const tk of val.split(/\s+/)) {
          const low = tk.toLowerCase();
          if (low === "portrait" || low === "landscape") out.orientation = low;
          else if (low === "auto") continue;
          else if (PAPER_NAME_BY_LOWER[low]) out.size = PAPER_NAME_BY_LOWER[low];
          else {
            const mm = cssLenToMm(tk);
            if (mm !== undefined) lens.push(mm);
          }
        }
        if (lens.length >= 2) out.size = { width: lens[0], height: lens[1], unit: "mm" };
      } else if (prop === "margin") {
        const t = val.split(/\s+/).map(cssLenToMm);
        // CSS 단축: 1=전면, 2=세로/가로, 3=상/가로/하, 4=상우하좌
        let top: number | undefined, right: number | undefined, bottom: number | undefined, left: number | undefined;
        if (t.length === 1) [top, right, bottom, left] = [t[0], t[0], t[0], t[0]];
        else if (t.length === 2) [top, right, bottom, left] = [t[0], t[1], t[0], t[1]];
        else if (t.length === 3) [top, right, bottom, left] = [t[0], t[1], t[2], t[1]];
        else [top, right, bottom, left] = [t[0], t[1], t[2], t[3]];
        setMargin("top", top);
        setMargin("right", right);
        setMargin("bottom", bottom);
        setMargin("left", left);
      } else if (prop === "margin-top") setMargin("top", cssLenToMm(val));
      else if (prop === "margin-right") setMargin("right", cssLenToMm(val));
      else if (prop === "margin-bottom") setMargin("bottom", cssLenToMm(val));
      else if (prop === "margin-left") setMargin("left", cssLenToMm(val));
    }
  }
  if (!found) return undefined;
  if (hasMargin) out.margins = margins;
  return out.size !== undefined || out.orientation !== undefined || out.margins !== undefined
    ? out
    : undefined;
}

/**
 * 페이지 옵션 병합 — 필드별 API(api) 우선, 빈 자리는 @page CSS(css)로 채움 (wku).
 * deriveHtmlPageDef 의 pageOpt 로 넘기면 컨테이너 휴리스틱은 자동으로 그 아래가 된다.
 */
function mergePageOpt(api?: PageSetupOption, css?: PageSetupOption): PageSetupOption | undefined {
  if (!api) return css;
  if (!css) return api;
  const am = api.margins;
  const cm = css.margins;
  const margins =
    am || cm
      ? {
          left: am?.left ?? cm?.left,
          right: am?.right ?? cm?.right,
          top: am?.top ?? cm?.top,
          bottom: am?.bottom ?? cm?.bottom,
          header: am?.header ?? cm?.header,
          footer: am?.footer ?? cm?.footer,
          gutter: am?.gutter ?? cm?.gutter,
        }
      : undefined;
  return {
    size: api.size ?? css.size,
    orientation: api.orientation ?? css.orientation,
    margins,
  };
}

/**
 * 페이지 설정 도출 → HwpPageDef (p1x·4qp). 한글 네이티브 모델: 용지 물리치수 고정 + landscape 플래그.
 * 필드별 우선순위: 명시 옵션(pageOpt = API > @page CSS 병합) > 컨테이너 CSS(padding/max-width) > 기본(A4 / 세로 / 한글기본여백).
 * 신호가 전혀 없으면(옵션·컨테이너 단서 모두 없음) undefined → 빌더 기본 폴백(현행 출력 바이트 동일).
 */
function deriveHtmlPageDef(
  container: HtmlNode | undefined,
  pageOpt?: PageSetupOption
): HwpPageDef | undefined {
  const style = container?.attrs.style;
  const pad = parsePaddingSides(style);
  const bodyWidth = parseContainerWidthHwp(style);
  const hasPad =
    pad.left !== undefined || pad.right !== undefined || pad.top !== undefined || pad.bottom !== undefined;
  const m = pageOpt?.margins;
  const hasMarginOpt =
    !!m &&
    (m.left !== undefined ||
      m.right !== undefined ||
      m.top !== undefined ||
      m.bottom !== undefined ||
      m.header !== undefined ||
      m.footer !== undefined ||
      m.gutter !== undefined);
  const hasOpt = !!pageOpt && (pageOpt.size !== undefined || pageOpt.orientation !== undefined || hasMarginOpt);
  // 신호 전무 → undefined(빌더 기본 폴백, 바이트 동일)
  if (!hasOpt && !hasPad && bodyWidth === undefined) return undefined;

  // 용지: 물리 치수 고정(세로 기준). 방향과 무관하게 스왑하지 않는다.
  const paper = resolvePaperSize(pageOpt?.size);

  // 여백: 옵션(mm) > 컨테이너 padding(면별) > 한글 기본.
  const optMm = (v: number | undefined): number | undefined => (v === undefined ? undefined : mmToHwpUnit(v));
  const left = optMm(m?.left) ?? pad.left ?? DEFAULT_PAGE_MARGIN.left;
  const right = optMm(m?.right) ?? pad.right ?? DEFAULT_PAGE_MARGIN.right;
  const top = optMm(m?.top) ?? pad.top ?? DEFAULT_PAGE_MARGIN.top;
  const bottom = optMm(m?.bottom) ?? pad.bottom ?? DEFAULT_PAGE_MARGIN.bottom;
  const header = optMm(m?.header) ?? DEFAULT_PAGE_MARGIN.header;
  const footer = optMm(m?.footer) ?? DEFAULT_PAGE_MARGIN.footer;
  const gutter = optMm(m?.gutter) ?? DEFAULT_PAGE_MARGIN.gutter;

  // 방향: 명시 옵션 우선, 기본 'auto'(본문폭이 세로 가용폭을 넘으면 가로). 치수 스왑 없이 플래그만.
  const orientation = pageOpt?.orientation ?? "auto";
  let landscape: boolean;
  if (orientation === "portrait") landscape = false;
  else if (orientation === "landscape") landscape = true;
  else {
    const portraitUsable = paper.width - left - right; // 세로(짧은 변) 가용폭
    landscape = bodyWidth !== undefined && bodyWidth > portraitUsable;
  }

  return {
    width: paper.width,
    height: paper.height,
    left,
    right,
    top,
    bottom,
    header,
    footer,
    gutter,
    landscape,
  };
}

export function htmlToHwpDocument(html: string, options?: ConvertOptions): HwpDocument {
  const { root: tree, styleText } = parseToTree(html);
  // 페이지 옵션: API(options.page) > @page CSS 병합. 컨테이너 휴리스틱은 deriveHtmlPageDef 안에서 그 아래.
  const effPage = mergePageOpt(options?.page, parseAtPage(styleText));

  const ctx: BuildContext = {
    charShapeIds: new Map(),
    binData: new Map(),
    nextBinDataId: 1,
    imageResolver: options?.imageResolver,
    charShapes: [defaultCharShape()],
    paraShapes: [defaultParaShape()],
    paraShapeIds: new Map([["default", 0]]),
    borderFills: [], // 커스텀 채우기만. 한컴 예약 기본(none/solid)은 빌더가 id 1·2 로 선두 출력.
    borderFillIds: new Map(),
  };
  ctx.charShapeIds.set("default", 0);

  const ids: ShapeIds = {
    idDefault: 0,
    idBold: registerCharShape(ctx, { ...defaultCharShape(), bold: true }),
    idItalic: registerCharShape(ctx, { ...defaultCharShape(), italic: true }),
    idBoldItalic: registerCharShape(ctx, { ...defaultCharShape(), bold: true, italic: true }),
    idMono: registerCharShape(ctx, {
      ...defaultCharShape(),
      faceNameIds: { hangul: 2, latin: 2, hanja: 2, japanese: 2, other: 2, symbol: 2, user: 2 },
    }),
    idH1: registerCharShape(ctx, { ...defaultCharShape(), bold: true, baseSize: 1800 }),
    idH2: registerCharShape(ctx, { ...defaultCharShape(), bold: true, baseSize: 1600 }),
    idH3: registerCharShape(ctx, { ...defaultCharShape(), bold: true, baseSize: 1400 }),
    idHmin: registerCharShape(ctx, { ...defaultCharShape(), bold: true, baseSize: 1200 }),
  };

  const paragraphs: HwpParagraph[] = [];
  const initialState: InlineState = { bold: false, italic: false, mono: false };

  for (const child of tree.children) {
    paragraphs.push(...renderNode(child, ids, ctx, initialState, ""));
  }

  // 빈 paragraph 제거. 단 테두리 있는 run(도장박스 placeholder)이 있으면 보존 —
  // text.trim() 은 전각공백을 지우므로 placeholder 만 있는 문단이 사라지는 것을 막는다.
  const filtered = paragraphs.filter(
    (p) =>
      p.text.trim().length > 0 ||
      p.controls.length > 0 ||
      p.runs.some((r) => ctx.charShapes[r.charShapeId]?.borderFillId !== undefined)
  );

  // 페이지 설정: 병합 옵션(API > @page CSS) > 루트 컨테이너 CSS > 기본. 신호 없으면 undefined → 빌더 기본 폴백.
  const pageDef = deriveHtmlPageDef(findPageContainer(tree), effPage);

  return {
    header: defaultFileHeader(),
    docInfo: {
      fontFaces: [
        [{ name: "함초롬바탕" }, { name: "맑은 고딕" }, { name: "Courier New" }],
        [{ name: "Times New Roman" }],
        [],
        [],
        [],
        [],
        [],
      ],
      charShapes: ctx.charShapes,
      paraShapes: ctx.paraShapes,
      styles: [{ name: "바탕글", engName: "Normal", paraShapeId: 0, charShapeId: 0 }],
      binData: [],
      borderFills: ctx.borderFills,
      numberings: [],
      bullets: [],
      tabDefs: [],
    },
    sections: [{ paragraphs: filtered, ...(pageDef ? { pageDef } : {}) }],
    binData: ctx.binData,
  };
}

function renderNode(
  node: HtmlNode | string,
  ids: ShapeIds,
  ctx: BuildContext,
  state: InlineState,
  prefix: string
): HwpParagraph[] {
  if (typeof node === "string") {
    const text = collapseWhitespace(node);
    if (!text) return [];
    return [
      {
        paraShapeId: 0,
        styleId: 0,
        text: prefix + text,
        runs:
          prefix.length > 0
            ? [
                { charShapeId: ids.idDefault, text: prefix },
                { charShapeId: pickInlineId(ids, state), text },
              ]
            : [{ charShapeId: pickInlineId(ids, state), text }],
        controls: [],
      },
    ];
  }

  const tag = node.tag.toLowerCase();

  // 블록 레벨 태그 처리
  switch (tag) {
    case "div":
    case "section":
    case "article": {
      // inheritAlign 1-level 규칙: 받은 정렬을 이 노드에서 소비하고, 자식 기본 state 에선 비운다.
      const incomingAlign = state.inheritAlign;
      const baseState: InlineState = { ...state, inheritAlign: undefined };
      // CSS 가로 다단(display:grid / display:flex row + 블록 자식 ≥2)이면 좌우 배치 표로 합성(a2m).
      const layout = parseLayoutStyle(node.attrs.style);
      if (layout && isLayoutMultiColumn(node, layout)) {
        return [collectDivColumnsAsParagraph(node, layout, ids, ctx, baseState)];
      }
      // 명시 width span 또는 도장박스로 구성된 인라인 flex 행 → 무테 표로 승격(우측정렬 보존).
      if (layout && isInlineWidthRow(node, layout)) {
        return [collectInlineSpansAsRowTable(node, layout, ids, ctx, baseState, incomingAlign)];
      }
      // 이 컨테이너가 flex 면 가로축 정렬을 직접 자식에게만 주입(1단계).
      const crossAlign = parseCrossAlign(node.attrs.style);
      const childState: InlineState = crossAlign ? { ...baseState, inheritAlign: crossAlign } : baseState;
      return renderNodeChildren(node, ids, ctx, childState, prefix);
    }
    case "p":
      // 컨테이너: 자식이 모두 inline 이면 단일 문단, 블록(table/ul/p 등)이 섞이면
      // 각 블록 자식을 renderNode 로 재귀 처리한다. (중첩 table 평탄화 방지)
      return renderNodeChildren(node, ids, ctx, state, prefix);
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const depth = Number(tag[1]);
      const hStyle = parseInlineStyle(node.attrs.style);
      // 제목 자체 color 가 있으면 제목 글자모양(굵게+제목 크기)에 글자색을 합쳐서 base 로 쓴다.
      // (없으면 기본 제목 모양 그대로 — 회귀 없음. walkInline 은 baseId 를 직접 쓰므로 여기서 색을 실어야 함)
      const headingSize = depth === 1 ? 1800 : depth === 2 ? 1600 : depth === 3 ? 1400 : 1200;
      const baseShapeId =
        hStyle.textColor !== undefined
          ? registerCharShape(ctx, {
              ...defaultCharShape(),
              bold: true,
              baseSize: headingSize,
              textColor: hStyle.textColor,
            })
          : depth === 1
            ? ids.idH1
            : depth === 2
              ? ids.idH2
              : depth === 3
                ? ids.idH3
                : ids.idHmin;
      const runs = collectInlineRuns(node, ids, ctx, state, baseShapeId);
      const text = runsToText(runs);
      if (!text) return [];
      const hBfId =
        hStyle.shadeColor !== undefined
          ? registerBorderFill(ctx, hStyle.shadeColor, false)
          : undefined;
      return [
        {
          paraShapeId:
            hStyle.align !== undefined || hBfId !== undefined
              ? registerParaShape(ctx, hStyle.align ?? "justify", hBfId)
              : 0,
          styleId: 0,
          text,
          runs,
          controls: [],
        },
      ];
    }
    case "ul":
    case "ol": {
      const out: HwpParagraph[] = [];
      let idx = 1;
      for (const child of node.children) {
        if (typeof child === "string") continue;
        if (child.tag !== "li") continue;
        const liPrefix = tag === "ul" ? "- " : `${idx}. `;
        const inner = renderNodeChildren(child, ids, ctx, state, liPrefix);
        if (inner.length === 0) {
          out.push({
            paraShapeId: 0,
            styleId: 0,
            text: liPrefix,
            runs: [{ charShapeId: ids.idDefault, text: liPrefix }],
            controls: [],
          });
        } else {
          out.push(...inner);
        }
        idx++;
      }
      return out;
    }
    case "blockquote": {
      const inner = renderNodeChildren(node, ids, ctx, state, "");
      return inner.map((p) => {
        const text = `> ${p.text}`;
        const runs: HwpRun[] = [
          { charShapeId: p.runs[0]?.charShapeId ?? ids.idDefault, text: "> " },
          ...p.runs,
        ];
        return { ...p, text, runs };
      });
    }
    case "table": {
      return [collectTableParagraph(node, ids, ctx)];
    }
    case "br":
      return [
        {
          paraShapeId: 0,
          styleId: 0,
          text: "",
          runs: [],
          controls: [],
        },
      ];
    case "hr":
      return [
        {
          paraShapeId: 0,
          styleId: 0,
          text: "─────",
          runs: [{ charShapeId: ids.idDefault, text: "─────" }],
          controls: [],
        },
      ];
    case "pre": {
      // 코드블록: HTML <pre> 의 배경·테두리·구문강조(토큰) 색·줄바꿈을 보존한다.
      // 배경 박스+외곽 테두리는 1×1 표 셀(채우기+테두리)로, 토큰색은 줄 문단의 색 run 으로,
      // 들여쓰기/개행은 extractPreLines(공백 비축약)로 — 한글에서 코드블록이 박스로 렌더된다.
      const ps = parseInlineStyle(node.attrs.style);
      const border = parseBorderStyle(node.attrs.style);
      const padding = parsePadding(node.attrs.style);
      const baseState: InlineState = { bold: false, italic: false, mono: true };
      if (ps.baseSize !== undefined) baseState.baseSize = ps.baseSize;
      if (ps.textColor !== undefined) baseState.textColor = ps.textColor; // 토큰 밖 코드 기본색
      const leftPara = registerParaShape(ctx, "left");
      const lines = extractPreLines(node, ids, ctx, baseState);
      const codeParas: HwpParagraph[] = (lines.length > 0 ? lines : [[]]).map((runs) => ({
        paraShapeId: leftPara,
        styleId: 0,
        text: runsToText(runs),
        runs,
        controls: [],
      }));
      const bg = ps.shadeColor;
      let borderFillId: number | undefined;
      if (border.hasBorder) borderFillId = registerBorderFillEx(ctx, border.borders, bg);
      else if (bg !== undefined) borderFillId = registerBorderFill(ctx, bg, false);
      return [
        {
          paraShapeId: 0,
          styleId: 0,
          text: "",
          runs: [],
          controls: [
            {
              kind: "table",
              rowCount: 1,
              colCount: 1,
              borderless: !border.hasBorder,
              cells: [
                {
                  col: 0,
                  row: 0,
                  colSpan: 1,
                  rowSpan: 1,
                  borderFillId,
                  cellMargin: padding,
                  vertAlign: "TOP",
                  paragraphs: codeParas,
                },
              ],
            },
          ],
        },
      ];
    }
    case "img": {
      const ctrl = imageNodeToControl(node, ctx);
      if (!ctrl) return [];
      return [
        {
          paraShapeId: 0,
          styleId: 0,
          text: "",
          runs: [],
          controls: [ctrl],
        },
      ];
    }
    case "html":
    case "body":
    case "main":
    case "header":
    case "footer":
    case "nav":
    case "aside":
    case "figure":
    case "figcaption":
      return renderNodeChildren(node, ids, ctx, state, prefix);
    default:
      // 인라인 컨테이너로 처리 (span/strong/em/code/a 등)
      // 단, blockquote/list 등은 위에서 처리됨
      return renderNodeChildren(node, ids, ctx, state, prefix);
  }
}

function renderNodeChildren(
  node: HtmlNode,
  ids: ShapeIds,
  ctx: BuildContext,
  state: InlineState,
  prefix: string
): HwpParagraph[] {
  // 자식이 모두 인라인이면 단일 paragraph 로 합치기
  const allInline = node.children.every((c) => typeof c === "string" || isInlineTag(c.tag));
  if (allInline) {
    const runs = collectInlineRuns(node, ids, ctx, state);
    const text = runsToText(runs);
    const controls = collectInlineControls(node, ctx);
    if (!text && controls.length === 0) return [];
    const ownStyle = parseInlineStyle(node.attrs.style);
    const align = ownStyle.align;
    // 블록 태그의 배경은 문단 전체 채우기(borderFill)로. 인라인 태그 배경은 walkInline 이 글자 음영 처리.
    const blockBg = !isInlineTag(node.tag) ? ownStyle.shadeColor : undefined;
    const bfId = blockBg !== undefined ? registerBorderFill(ctx, blockBg, false) : undefined;
    return [
      {
        paraShapeId:
          align !== undefined || bfId !== undefined
            ? registerParaShape(ctx, align ?? "justify", bfId)
            : 0,
        styleId: 0,
        text: prefix + text,
        runs:
          prefix.length > 0
            ? [{ charShapeId: ids.idDefault, text: prefix }, ...runs]
            : runs,
        controls,
      },
    ];
  }
  // 블록 자식이 섞여있으면 각각 별도 paragraph 로
  const out: HwpParagraph[] = [];
  let blockPrefix = prefix;
  for (const child of node.children) {
    out.push(...renderNode(child, ids, ctx, state, blockPrefix));
    blockPrefix = ""; // prefix 는 첫 paragraph 에만 적용
  }
  return out;
}

function isInlineTag(tag: string): boolean {
  return [
    "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn", "em", "i", "kbd",
    "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var",
    "wbr", "del", "ins", "img",
  ].includes(tag);
}

function collectInlineRuns(
  node: HtmlNode,
  ids: ShapeIds,
  ctx: BuildContext,
  state: InlineState,
  baseId?: number
): HwpRun[] {
  const runs: HwpRun[] = [];
  walkInline(node, ids, ctx, state, runs, baseId ?? null);
  return mergeRuns(runs);
}

function walkInline(
  node: HtmlNode | string,
  ids: ShapeIds,
  ctx: BuildContext,
  state: InlineState,
  runs: HwpRun[],
  baseId: number | null
): void {
  if (typeof node === "string") {
    const text = collapseWhitespace(node);
    if (text.length === 0) return;
    runs.push({
      charShapeId: baseId !== null ? baseId : resolveInlineCharShape(ids, ctx, state),
      text,
    });
    return;
  }
  const tag = node.tag.toLowerCase();
  if (tag === "img") {
    // 이미지는 별도 컨트롤. 인라인에서는 alt 만 노출.
    const alt = node.attrs.alt;
    if (alt) {
      runs.push({ charShapeId: resolveInlineCharShape(ids, ctx, state), text: alt });
    }
    return;
  }
  if (tag === "br") {
    runs.push({ charShapeId: resolveInlineCharShape(ids, ctx, state), text: "\n" });
    return;
  }
  let nextState = state;
  if (tag === "strong" || tag === "b") nextState = { ...nextState, bold: true };
  if (tag === "em" || tag === "i") nextState = { ...nextState, italic: true };
  if (tag === "code" || tag === "samp" || tag === "kbd") nextState = { ...nextState, mono: true };
  // inline style(color/background-color/font-size) 상속 누적
  const st = parseInlineStyle(node.attrs.style);
  if (st.textColor !== undefined) nextState = { ...nextState, textColor: st.textColor };
  // 배경은 인라인 태그(span/strong 등)만 글자 음영(shadeColor)으로 전파.
  // 블록(div/p/td 등)의 배경은 문단/셀 borderFill 로 분기되므로 글자 음영으로 새지 않게 한다.
  if (st.shadeColor !== undefined && isInlineTag(tag)) nextState = { ...nextState, shadeColor: st.shadeColor };
  if (st.baseSize !== undefined) nextState = { ...nextState, baseSize: st.baseSize };
  // 인라인 요소(span 등)의 border → 글자 테두리(도장박스). 자식 run 에 실린다.
  const ib = isInlineTag(tag) ? parseBorderStyle(node.attrs.style) : { hasBorder: false, borders: null };
  if (ib.hasBorder) {
    const bfId = registerBorderFillEx(ctx, ib.borders, undefined);
    if (bfId !== undefined) nextState = { ...nextState, borderFillId: bfId };
  }
  const before = runs.length;
  for (const child of node.children) {
    walkInline(child, ids, ctx, nextState, runs, baseId);
  }
  // 빈 bordered 요소(도장박스: 텍스트 0) → placeholder run 으로 박스 가시화.
  if (ib.hasBorder && runs.length === before) {
    runs.push({ charShapeId: resolveInlineCharShape(ids, ctx, nextState), text: "　　" });
  }
}

function collectInlineControls(node: HtmlNode, ctx: BuildContext): HwpControl[] {
  const out: HwpControl[] = [];
  const visit = (n: HtmlNode | string): void => {
    if (typeof n === "string") return;
    if (n.tag === "img") {
      const ctrl = imageNodeToControl(n, ctx);
      if (ctrl) out.push(ctrl);
      return;
    }
    for (const c of n.children) visit(c);
  };
  for (const c of node.children) visit(c);
  return out;
}

/** layout 컨테이너를 표로 변환할지 판정 — 블록 자식 ≥2 이고 의미있는 비블록 자식이 없을 때만(F-02 유실 방지). */
function isLayoutMultiColumn(node: HtmlNode, layout: LayoutStyle): boolean {
  const blockChildren = node.children.filter(
    (c) => typeof c !== "string" && !isInlineTag(c.tag)
  );
  if (blockChildren.length < 2) return false;
  // 공백 아닌 텍스트 / 인라인 요소 자식이 섞이면 변환 안 함 → renderNodeChildren 폴백으로 전부 보존
  const hasMeaningfulInline = node.children.some((c) =>
    typeof c === "string" ? collapseWhitespace(c).length > 0 : isInlineTag(c.tag)
  );
  if (hasMeaningfulInline) return false;
  if (layout.kind === "grid" && (layout.templateColsHwp?.length ?? 0) < 2) return false;
  return true;
}

/** grid-template-columns 가 모두 px 면 컬럼별 너비(HWPUNIT) 반환, 아니면 undefined(빌더가 균등분할). */
function layoutColWidths(layout: LayoutStyle, cols: number): number[] | undefined {
  const t = layout.templateColsHwp;
  if (layout.kind === "grid" && t && t.length === cols && t.every((v) => v !== null && v > 0)) {
    return t as number[];
  }
  return undefined;
}

/** div CSS 다단(grid/flex row) → 테두리 없는 1행/N열 레이아웃 표 합성. (a2m) */
function collectDivColumnsAsParagraph(
  container: HtmlNode,
  layout: LayoutStyle,
  ids: ShapeIds,
  ctx: BuildContext,
  state: InlineState
): HwpParagraph {
  const blockChildren = container.children.filter(
    (c): c is HtmlNode => typeof c !== "string" && !isInlineTag(c.tag)
  );
  const cols = Math.max(
    1,
    layout.kind === "grid" ? layout.templateColsHwp?.length ?? blockChildren.length : blockChildren.length
  );
  const rows = Math.max(1, Math.ceil(blockChildren.length / cols));
  const emptyPara = (): HwpParagraph => ({
    paraShapeId: 0,
    styleId: 0,
    text: "",
    runs: [],
    controls: [],
  });
  const cells: HwpTableCell[] = [];
  for (let idx = 0; idx < rows * cols; idx++) {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const child = blockChildren[idx];
    // F-01: renderNode(child) — child 가 또 layout 이면 중첩 표로, 아니면 renderNodeChildren 경로로 정규화.
    const paragraphs = child ? renderNode(child, ids, ctx, state, "") : [];
    // PR-03: 셀에는 자식 div 의 border 만(채우기 X). 배경은 renderNode(child) 의 igp 문단 채우기에 위임.
    const border = child ? parseBorderStyle(child.attrs.style) : { hasBorder: false, borders: null };
    const borderFillId = border.hasBorder
      ? registerBorderFillEx(ctx, border.borders, undefined)
      : undefined;
    // 마감: padding→cellMargin, vertical-align→vertAlign(H-02: 레이아웃 셀 기본 TOP).
    const cellMargin = child ? parsePadding(child.attrs.style) : undefined;
    const vertAlign = (child ? parseInlineStyle(child.attrs.style).vAlign : undefined) ?? "TOP";
    cells.push({
      col,
      row,
      colSpan: 1,
      rowSpan: 1,
      borderFillId,
      cellMargin,
      vertAlign,
      paragraphs: paragraphs.length > 0 ? paragraphs : [emptyPara()],
    });
  }
  return {
    paraShapeId: 0,
    styleId: 0,
    text: "",
    runs: [],
    tightTableAnchor: true, // HTML 표앵커: 표 위 빈 줄 최소화(빌더 Fix B)
    controls: [
      {
        kind: "table",
        rowCount: rows,
        colCount: cols,
        cells,
        colWidths: layoutColWidths(layout, cols),
        borderless: true,
        cellSpacing: layout.gapHwp,
      },
    ],
  };
}

/** style 선언에서 단일 prop 값 추출. */
function cssProp(style: string | undefined, prop: string): string | undefined {
  if (!style) return undefined;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    if (decl.slice(0, i).trim().toLowerCase() === prop) return decl.slice(i + 1).trim();
  }
  return undefined;
}

/** 노드의 텍스트 내용(자손 문자열 합) — walkInline placeholder 우회용 공백 판정에 사용. */
function nodeText(node: HtmlNode | string): string {
  if (typeof node === "string") return node;
  let s = "";
  for (const c of node.children) s += nodeText(c);
  return s;
}

/** 인라인 span(명시 width 또는 도장박스 포함)으로 구성된 flex/grid 행 → 무테 표 승격 대상 판정. */
function isInlineWidthRow(node: HtmlNode, layout: LayoutStyle): boolean {
  if (layout.kind !== "flexRow" && layout.kind !== "grid") return false;
  // 블록 자식이 섞이면 기존 collectDivColumnsAsParagraph 경로에 양보.
  if (node.children.some((c) => typeof c !== "string" && !isInlineTag(c.tag))) return false;
  // 공백 아닌 텍스트노드가 섞이면 셀화 시 유실되므로 승격 포기(폴백 보존). 태그 사이 개행/들여쓰기는 무시.
  if (node.children.some((c) => typeof c === "string" && c.trim().length > 0)) return false;
  const spans = node.children.filter(
    (c): c is HtmlNode => typeof c !== "string" && isInlineTag(c.tag) && c.tag.toLowerCase() !== "br"
  );
  if (spans.length < 2) return false;
  // 트리거: 명시 width(px>0) 보유 ≥1 또는 bordered 빈 span(도장박스).
  const hasWidth = spans.some((s) => {
    const w = parseLengthPxPct(cssProp(s.attrs.style, "width"));
    return w !== undefined && !w.pct && w.v > 0;
  });
  const hasSeal = spans.some(
    (s) => parseBorderStyle(s.attrs.style).hasBorder && collapseWhitespace(nodeText(s)).length === 0
  );
  return hasWidth || hasSeal;
}

/** 자손에 strong/b 가 있는지(굵게 폭 보정용). */
function hasBoldTag(node: HtmlNode): boolean {
  for (const c of node.children) {
    if (typeof c === "string") continue;
    const t = c.tag.toLowerCase();
    if (t === "strong" || t === "b") return true;
    if (hasBoldTag(c)) return true;
  }
  return false;
}

/** span 텍스트의 HWP 추정 폭(HWPUNIT). KEEP(줄바꿈 금지) 셀이 글자보다 좁아 겹치는 것을 막는 바닥값.
 *  한글/CJK/전각 ≈ 1em, ASCII ≈ 0.55em, 굵게 ×1.08. font-size 미지정 시 16px 가정. */
function estTextWidthHwp(span: HtmlNode): number {
  const text = nodeText(span);
  if (!text.trim()) return 0;
  const fontPx = parseLengthPxPct(cssProp(span.attrs.style, "font-size"))?.v ?? 16;
  const fw = cssProp(span.attrs.style, "font-weight");
  const bold = (fw !== undefined && (fw === "bold" || Number(fw) >= 600)) || hasBoldTag(span);
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    w += code >= 0x1100 ? fontPx : fontPx * 0.55; // >=0x1100: 한글/CJK/전각
  }
  if (bold) w *= 1.08;
  return pxToHwpUnit(w);
}

/** 인라인 span flex/grid 행 → 1행 N열 무테 표(셀=span). width 보존 + 도장박스 정사각 셀 + 우측정렬. */
function collectInlineSpansAsRowTable(
  container: HtmlNode,
  layout: LayoutStyle,
  ids: ShapeIds,
  ctx: BuildContext,
  state: InlineState,
  incomingAlign?: HwpParaShape["alignment"]
): HwpParagraph {
  const spans = container.children.filter(
    (c): c is HtmlNode => typeof c !== "string" && isInlineTag(c.tag) && c.tag.toLowerCase() !== "br"
  );
  const cols = Math.max(1, spans.length);
  const cellState: InlineState = { ...state, inheritAlign: undefined };
  const emptyPara = (): HwpParagraph => ({ paraShapeId: 0, styleId: 0, text: "", runs: [], controls: [] });
  const cells: HwpTableCell[] = [];
  const colWidths: number[] = [];
  let allHaveWidth = true;
  spans.forEach((span, idx) => {
    const border = parseBorderStyle(span.attrs.style);
    const borderFillId = border.hasBorder ? registerBorderFillEx(ctx, border.borders, undefined) : undefined;
    // PR-01: 빈 bordered span(도장칸)은 collectInlineRuns 우회 → walkInline placeholder "　　" 미주입, 빈 셀+셀 border.
    const isEmptyBordered = border.hasBorder && collapseWhitespace(nodeText(span)).length === 0;
    const runs = isEmptyBordered ? [] : collectInlineRuns(span, ids, ctx, cellState);
    const para =
      runs.length > 0
        ? { paraShapeId: 0, styleId: 0, text: runsToText(runs), runs, controls: [] }
        : emptyPara();
    const w = parseLengthPxPct(cssProp(span.attrs.style, "width"));
    const designW = w && !w.pct && w.v > 0 ? pxToHwpUnit(w.v) : 0;
    // 콘텐츠 최소폭 바닥: KEEP 셀이 텍스트보다 좁으면 글자가 겹친다(예: 발주자 47.77px 굵은 3자 → "발자").
    const minW = isEmptyBordered ? 0 : estTextWidthHwp(span);
    const colW = Math.max(designW, minW);
    if (colW <= 0) allHaveWidth = false;
    colWidths.push(colW);
    // 레이아웃 셀 안쪽여백 0: span width 는 브라우저에서 content-box(여백 없음)라, 기본 셀여백(좌우 510)을
    // 두면 딱 맞게 설계된 라벨(예: 발주자 47.77px)이 넘쳐 세로 줄바꿈된다. gap 은 cellSpacing 으로 별도 반영.
    cells.push({
      col: idx,
      row: 0,
      colSpan: 1,
      rowSpan: 1,
      borderFillId,
      cellMargin: { left: 0, right: 0, top: 0, bottom: 0 },
      vertAlign: "CENTER",
      paragraphs: [para],
    });
  });
  // 우측정렬: 부모 align-items(incomingAlign) 우선, 없으면 이 행의 justify-content.
  const rowAlign = incomingAlign ?? parseCrossAlign(container.attrs.style);
  const wrapParaId = rowAlign ? registerParaShape(ctx, rowAlign) : 0;
  return {
    paraShapeId: wrapParaId,
    styleId: 0,
    text: "",
    runs: [],
    tightTableAnchor: true, // HTML 표앵커: 표 위 빈 줄 최소화(빌더 Fix B)
    controls: [
      {
        kind: "table",
        rowCount: 1,
        colCount: cols,
        cells,
        colWidths: allHaveWidth ? colWidths : undefined,
        borderless: true,
        cellSpacing: layout.gapHwp,
        fitContent: true,
      },
    ],
  };
}

function collectTableParagraph(
  table: HtmlNode,
  ids: ShapeIds,
  ctx: BuildContext
): HwpParagraph {
  // <tr> 수집 (thead/tbody/tfoot 평탄화)
  const trs: HtmlNode[] = [];
  const collectTrs = (n: HtmlNode): void => {
    for (const c of n.children) {
      if (typeof c === "string") continue;
      if (c.tag === "tr") trs.push(c);
      else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") collectTrs(c);
    }
  };
  collectTrs(table);

  // 표 기본 테두리 정책(docx-convert 미러링): CSS border 가 전혀 없는 <table> 은 무테(셀 default=NONE).
  // <table style="border:…"> 처럼 표레벨 border 가 명시되면 비-borderless 로 두어 기본 격자(id 2)를 유지한다.
  // (collectTableParagraph 는 td/th style 만 해석하므로 표레벨 border 는 여기서만 판정한다.)
  const tableBorder = parseBorderStyle(table.attrs.style);

  // rowspan/colspan 점유 그리드로 실제 셀 좌표(colAddr/rowAddr)를 계산한다.
  // 단순히 셀마다 col 을 1 증가시키면 병합 셀이 점유한 칸을 무시해 좌표가 어긋난다.
  let maxCols = 0;
  const occupied = new Set<string>();
  const tcs: {
    row: number;
    col: number;
    isHeader: boolean;
    node: HtmlNode;
    colSpan: number;
    rowSpan: number;
  }[] = [];
  for (let r = 0; r < trs.length; r++) {
    let col = 0;
    for (const c of trs[r].children) {
      if (typeof c === "string") continue;
      if (c.tag !== "td" && c.tag !== "th") continue;
      // 위쪽 행의 rowspan 이나 같은 행 colspan 이 점유한 칸은 건너뛴다.
      while (occupied.has(`${r},${col}`)) col++;
      const colSpan = Math.max(1, Number(c.attrs.colspan ?? "1") || 1);
      const rowSpan = Math.max(1, Number(c.attrs.rowspan ?? "1") || 1);
      tcs.push({ row: r, col, isHeader: c.tag === "th", node: c, colSpan, rowSpan });
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          occupied.add(`${r + dr},${col + dc}`);
        }
      }
      col += colSpan;
      if (col > maxCols) maxCols = col;
    }
  }

  const cells: HwpTableCell[] = tcs.map(({ row, col, isHeader, node, colSpan, rowSpan }) => {
    // baseId 를 고정하지 않고 state.bold 로 처리해야 셀의 inline style(색/크기)이 반영된다.
    const runs = collectInlineRuns(node, ids, ctx, { bold: isHeader, italic: false, mono: false });
    // 셀 배경/테두리 → 셀 borderFill. 명시 border 있으면 그 테두리, 없고 bg 만 있으면 검정 격자 유지(PR-01).
    const cellBg = parseInlineStyle(node.attrs.style).shadeColor;
    const cb = parseBorderStyle(node.attrs.style);
    let borderFillId: number | undefined;
    if (cb.hasBorder) borderFillId = registerBorderFillEx(ctx, cb.borders, cellBg);
    else if (cellBg !== undefined) borderFillId = registerBorderFill(ctx, cellBg, false); // 채우기만(테두리 없음): CSS border 미명시 → 무테(docx-convert 미러링)
    else borderFillId = undefined;
    // 마감: padding→cellMargin, vertical-align→vertAlign(데이터 셀은 미지정 시 빌더 기본 CENTER).
    const cellMargin = parsePadding(node.attrs.style);
    const vertAlign = parseInlineStyle(node.attrs.style).vAlign;
    return {
      col,
      row,
      colSpan,
      rowSpan,
      borderFillId,
      cellMargin,
      vertAlign,
      paragraphs: [
        {
          paraShapeId: 0,
          styleId: 0,
          text: runsToText(runs),
          runs,
          controls: [],
        },
      ],
    };
  });

  return {
    paraShapeId: 0,
    styleId: 0,
    text: "",
    runs: [],
    tightTableAnchor: true, // HTML 표앵커: 표 위 빈 줄 최소화(빌더 Fix B)
    controls: [
      { kind: "table", rowCount: trs.length, colCount: maxCols, cells, borderless: !tableBorder.hasBorder },
    ],
  };
}

/** CSS length(px/%) → {v, pct}. 그 외(auto 등) undefined. */
function parseLengthPxPct(val: string | undefined): { v: number; pct: boolean } | undefined {
  if (!val) return undefined;
  const s = val.trim();
  let m = /^([\d.]+)px$/.exec(s);
  if (m) return { v: parseFloat(m[1]), pct: false };
  m = /^([\d.]+)%$/.exec(s);
  if (m) return { v: parseFloat(m[1]), pct: true };
  m = /^([\d.]+)$/.exec(s); // 단위 없는 속성값 = px
  if (m) return { v: parseFloat(m[1]), pct: false };
  return undefined;
}

/** img 의 style width/height(우선) 또는 width/height 속성 → 표시 크기 힌트. */
function parseImgSize(node: HtmlNode): { width?: { v: number; pct: boolean }; height?: { v: number; pct: boolean } } {
  const style = node.attrs.style ?? "";
  const styleVal = (prop: string): string | undefined => {
    for (const decl of style.split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      if (decl.slice(0, i).trim().toLowerCase() === prop) return decl.slice(i + 1).trim();
    }
    return undefined;
  };
  const width = parseLengthPxPct(styleVal("width")) ?? parseLengthPxPct(node.attrs.width);
  const height = parseLengthPxPct(styleVal("height")) ?? parseLengthPxPct(node.attrs.height);
  return { width, height };
}

function imageNodeToControl(node: HtmlNode, ctx: BuildContext): HwpControl | null {
  const src = node.attrs.src ?? "";
  const size = parseImgSize(node);
  const match = /^data:([^;]+);base64,(.*)$/i.exec(src);
  if (!match) {
    // data URI 가 아니면 resolver(주입 시)로 file://·로컬 경로 해석. 없으면 skip.
    const resolved = src ? ctx.imageResolver?.(src) : null;
    if (resolved && resolved.data.length > 0) {
      const id = ctx.nextBinDataId++;
      ctx.binData.set(id, { data: resolved.data, extension: resolved.extension.toLowerCase() });
      return { kind: "picture", binDataId: id, ...size };
    }
    return null;
  }
  const mime = match[1].toLowerCase();
  const ext =
    mime === "image/png"
      ? "png"
      : mime === "image/jpeg"
        ? "jpg"
        : mime === "image/gif"
          ? "gif"
          : mime === "image/bmp"
            ? "bmp"
            : "bin";
  let bytes: Uint8Array;
  try {
    if (typeof Buffer !== "undefined") {
      bytes = new Uint8Array(Buffer.from(match[2], "base64"));
    } else {
      const bin = (globalThis as { atob?: (s: string) => string }).atob?.(match[2]) ?? "";
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
  } catch {
    return null;
  }
  const id = ctx.nextBinDataId++;
  ctx.binData.set(id, { data: bytes, extension: ext });
  return { kind: "picture", binDataId: id, ...size };
}

/**
 * <pre> 내용을 줄별 run 배열로 추출. 공백/들여쓰기/개행을 **축약 없이** 보존하고,
 * 토큰 <span style="color">·<strong>/<em> 을 색/굵기 run 으로 살린다(구문강조 보존).
 * 텍스트 노드의 "\n" 과 <br> 에서 줄을 분리한다. baseState 는 보통 { mono:true, baseSize, textColor }.
 */
function extractPreLines(
  node: HtmlNode,
  ids: ShapeIds,
  ctx: BuildContext,
  baseState: InlineState
): HwpRun[][] {
  const lines: HwpRun[][] = [[]];
  const pushText = (text: string, state: InlineState): void => {
    const segs = text.split("\n");
    for (let i = 0; i < segs.length; i++) {
      if (i > 0) lines.push([]); // 개행 → 새 줄
      if (segs[i].length > 0) {
        lines[lines.length - 1].push({
          charShapeId: resolveInlineCharShape(ids, ctx, state),
          text: segs[i],
        });
      }
    }
  };
  const visit = (n: HtmlNode | string, state: InlineState): void => {
    if (typeof n === "string") {
      pushText(n, state); // collapseWhitespace 미적용(공백 보존)
      return;
    }
    const tag = n.tag.toLowerCase();
    if (tag === "br") {
      lines.push([]);
      return;
    }
    let next = state;
    if (tag === "strong" || tag === "b") next = { ...next, bold: true };
    if (tag === "em" || tag === "i") next = { ...next, italic: true };
    const st = parseInlineStyle(n.attrs.style);
    if (st.textColor !== undefined) next = { ...next, textColor: st.textColor };
    if (st.baseSize !== undefined) next = { ...next, baseSize: st.baseSize };
    for (const c of n.children) visit(c, next);
  };
  for (const c of node.children) visit(c, baseState);
  return lines;
}

function pickInlineId(ids: ShapeIds, state: InlineState): number {
  if (state.mono) return ids.idMono;
  if (state.bold && state.italic) return ids.idBoldItalic;
  if (state.bold) return ids.idBold;
  if (state.italic) return ids.idItalic;
  return ids.idDefault;
}

function mergeRuns(runs: HwpRun[]): HwpRun[] {
  const out: HwpRun[] = [];
  for (const r of runs) {
    if (r.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.charShapeId === r.charShapeId) {
      last.text += r.text;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function runsToText(runs: HwpRun[]): string {
  return runs.map((r) => r.text).join("");
}

function collapseWhitespace(s: string): string {
  // HTML 텍스트 노드의 연속 공백을 단일 공백으로
  return s.replace(/[\s ]+/g, " ");
}

// ============================================================
// 기본 IR
// ============================================================

function defaultCharShape(): HwpCharShape {
  return {
    faceNameIds: { hangul: 0, latin: 1, hanja: 0, japanese: 0, other: 0, symbol: 0, user: 0 },
    baseSize: 1000,
    property: 0,
    textColor: 0,
    shadeColor: 0xffffff,
    underlineColor: 0,
    shadowColor: 0,
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
  };
}

function defaultParaShape(): HwpParaShape {
  return {
    alignment: "justify",
    property: 0,
    leftMargin: 0,
    rightMargin: 0,
    indent: 0,
    prevSpacing: 0,
    nextSpacing: 0,
    // HTML 경로 기본 줄간격: 브라우저 line-height:normal(≈1.2)·docx 단일에 근사하도록 130%.
    // (HWP 기본 160% 보다 타이트.) htmlReader 전용 — md=mdReader, HWP=docInfo 소스 별도라 무영향.
    // 단일행 문단은 빌더 lineseg 가 이 값을 spacing 으로 흘려 실제로 반영(buildLineSeg).
    lineSpacing: 130,
  };
}

/**
 * 단색 채우기 borderFill 동적 등록 → docInfo.borderFills(커스텀) 0-based 인덱스 반환.
 * withBorders=true → 표 셀(SOLID 검정 4면 격자 유지 + 채우기), false → 블록 문단(테두리 없음 + 채우기).
 * 색·테두리 조합으로 dedupe. 빌더가 예약 2개(none=id1, solid=id2) 뒤 id 3+ 로 출력한다.
 */
function registerBorderFill(ctx: BuildContext, fillColor: number, withBorders: boolean): number {
  const key = `bf:${fillColor}:${withBorders ? 1 : 0}`;
  const existing = ctx.borderFillIds.get(key);
  if (existing !== undefined) return existing;
  const line = (lineType: number) => ({ lineType, widthIndex: 0, color: 0 });
  const b = withBorders ? line(1) : line(0); // 1=SOLID, 0=NONE
  const id = ctx.borderFills.length;
  ctx.borderFills.push({
    attr: 0,
    borders: [{ ...b }, { ...b }, { ...b }, { ...b }],
    diagonal: { diagonalType: 0, widthIndex: 0, color: 0 },
    fill: { backgroundColor: fillColor, patternColor: 0, patternType: -1 },
  });
  ctx.borderFillIds.set(key, id);
  return id;
}

/**
 * 임의 4면 테두리 + 선택 채우기 borderFill 등록 → 0-based 커스텀 인덱스(없으면 undefined).
 * registerBorderFill 과 같은 ctx.borderFills 배열 공유(순차 인덱스), dedupe 키만 `bfx:` 로 분리.
 */
function registerBorderFillEx(
  ctx: BuildContext,
  borders: [HwpBorderLine, HwpBorderLine, HwpBorderLine, HwpBorderLine] | null,
  fillColor?: number
): number | undefined {
  if (!borders && fillColor === undefined) return undefined;
  const b = borders ?? ([0, 0, 0, 0].map(() => ({ lineType: 0, widthIndex: 0, color: 0 })) as [
    HwpBorderLine,
    HwpBorderLine,
    HwpBorderLine,
    HwpBorderLine,
  ]);
  const key = `bfx:${b.map((x) => `${x.lineType}-${x.widthIndex}-${x.color}`).join(",")}:${fillColor ?? "n"}`;
  const existing = ctx.borderFillIds.get(key);
  if (existing !== undefined) return existing;
  const id = ctx.borderFills.length;
  ctx.borderFills.push({
    attr: 0,
    borders: [{ ...b[0] }, { ...b[1] }, { ...b[2] }, { ...b[3] }],
    diagonal: { diagonalType: 0, widthIndex: 0, color: 0 },
    fill: fillColor !== undefined ? { backgroundColor: fillColor, patternColor: 0, patternType: -1 } : undefined,
  });
  ctx.borderFillIds.set(key, id);
  return id;
}

function defaultFileHeader(): HwpDocument["header"] {
  return {
    version: { major: 5, minor: 0, build: 6, revision: 0 },
    flags: {
      raw: 0,
      compressed: false,
      encrypted: false,
      distribution: false,
      script: false,
      drm: false,
      xmlTemplate: false,
      documentHistory: false,
      digitalSignature: false,
      publicKeyEncrypted: false,
      modifiedCertificate: false,
      prepareDistribution: false,
    },
  };
}

function registerCharShape(ctx: BuildContext, cs: HwpCharShape): number {
  const key = JSON.stringify(cs);
  const existing = ctx.charShapeIds.get(key);
  if (existing !== undefined) return existing;
  const id = ctx.charShapes.length;
  ctx.charShapes.push(cs);
  ctx.charShapeIds.set(key, id);
  return id;
}

/** 정렬 + 문단 배경(borderFillIDRef)별 paraShape 동적 등록. */
function registerParaShape(
  ctx: BuildContext,
  align: HwpParaShape["alignment"],
  borderFillIDRef?: number
): number {
  if (align === "justify" && borderFillIDRef === undefined) return 0; // 기본(default)과 동일
  const key = `align:${align}|bf:${borderFillIDRef ?? "n"}`;
  const existing = ctx.paraShapeIds.get(key);
  if (existing !== undefined) return existing;
  const id = ctx.paraShapes.length;
  ctx.paraShapes.push({ ...defaultParaShape(), alignment: align, borderFillIDRef });
  ctx.paraShapeIds.set(key, id);
  return id;
}

/**
 * InlineState(bold/italic/mono/color/size)에 해당하는 charShape id 를 반환.
 * 색·크기 변형이 없으면 고정 ids, 있으면 동적 등록.
 */
function resolveInlineCharShape(ids: ShapeIds, ctx: BuildContext, state: InlineState): number {
  if (
    state.textColor === undefined &&
    state.shadeColor === undefined &&
    state.baseSize === undefined &&
    state.borderFillId === undefined
  ) {
    return pickInlineId(ids, state);
  }
  const cs = defaultCharShape();
  cs.bold = state.bold;
  cs.italic = state.italic;
  if (state.mono) {
    cs.faceNameIds = { hangul: 2, latin: 2, hanja: 2, japanese: 2, other: 2, symbol: 2, user: 2 };
  }
  if (state.textColor !== undefined) cs.textColor = state.textColor;
  if (state.shadeColor !== undefined) cs.shadeColor = state.shadeColor;
  if (state.baseSize !== undefined) cs.baseSize = state.baseSize;
  if (state.borderFillId !== undefined) cs.borderFillId = state.borderFillId;
  return registerCharShape(ctx, cs);
}
