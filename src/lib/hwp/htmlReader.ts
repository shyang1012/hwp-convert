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
  ImageResolver,
  ConvertOptions,
} from "./types.js";

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (HtmlNode | string)[];
  parent: HtmlNode | null;
}

function parseToTree(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let current: HtmlNode = root;
  const voidTags = new Set([
    "br", "img", "hr", "input", "meta", "link", "source", "track", "wbr", "col", "area", "base", "embed",
  ]);
  const skipTags = new Set(["script", "style", "head", "noscript", "template"]);
  let inSkippedTag = 0;

  const parser = new Parser(
    {
      onopentag(name, attrs) {
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
        if (inSkippedTag > 0) return;
        current.children.push(text);
      },
      onclosetag(name) {
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
  return root;
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

/** CSS padding(단축 1~4값 / padding-{side}) → 4면 HWPUNIT. 없으면 undefined. */
function parsePadding(
  style: string | undefined
): { left: number; right: number; top: number; bottom: number } | undefined {
  if (!style) return undefined;
  const px = (v: string): number | undefined => {
    const m = /^([\d.]+)px$/.exec(v.trim());
    if (m) return pxToHwpUnit(parseFloat(m[1]));
    return /^0$/.test(v.trim()) ? 0 : undefined;
  };
  let top: number | undefined, right: number | undefined, bottom: number | undefined, left: number | undefined;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (prop === "padding") {
      const t = val.split(/\s+/).map(px);
      // CSS 단축: 1값=전면, 2값=세로/가로, 3값=상/가로/하, 4값=상우하좌
      if (t.length === 1) [top, right, bottom, left] = [t[0], t[0], t[0], t[0]];
      else if (t.length === 2) [top, right, bottom, left] = [t[0], t[1], t[0], t[1]];
      else if (t.length === 3) [top, right, bottom, left] = [t[0], t[1], t[2], t[1]];
      else if (t.length >= 4) [top, right, bottom, left] = [t[0], t[1], t[2], t[3]];
    } else if (prop === "padding-top") top = px(val);
    else if (prop === "padding-right") right = px(val);
    else if (prop === "padding-bottom") bottom = px(val);
    else if (prop === "padding-left") left = px(val);
  }
  if (top === undefined && right === undefined && bottom === undefined && left === undefined) return undefined;
  return { left: left ?? 0, right: right ?? 0, top: top ?? 0, bottom: bottom ?? 0 };
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

export function htmlToHwpDocument(html: string, options?: ConvertOptions): HwpDocument {
  const tree = parseToTree(html);

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
    sections: [{ paragraphs: filtered }],
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
      // CSS 가로 다단(display:grid / display:flex row + 블록 자식 ≥2)이면 좌우 배치 표로 합성(a2m).
      const layout = parseLayoutStyle(node.attrs.style);
      if (layout && isLayoutMultiColumn(node, layout)) {
        return [collectDivColumnsAsParagraph(node, layout, ids, ctx, state)];
      }
      return renderNodeChildren(node, ids, ctx, state, prefix);
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
      const baseShapeId =
        depth === 1 ? ids.idH1 : depth === 2 ? ids.idH2 : depth === 3 ? ids.idH3 : ids.idHmin;
      const runs = collectInlineRuns(node, ids, ctx, state, baseShapeId);
      const text = runsToText(runs);
      if (!text) return [];
      const hStyle = parseInlineStyle(node.attrs.style);
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
      // pre 안의 텍스트는 모노스페이스로 보존 (개행 유지)
      const monoState: InlineState = { ...state, mono: true };
      const text = extractPreText(node);
      const lines = text.split("\n");
      return lines.map((line) => ({
        paraShapeId: 0,
        styleId: 0,
        text: line,
        runs: line.length > 0 ? [{ charShapeId: pickInlineId(ids, monoState), text: line }] : [],
        controls: [],
      }));
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
    else if (cellBg !== undefined) borderFillId = registerBorderFill(ctx, cellBg, true); // 격자+채우기 유지
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
    controls: [{ kind: "table", rowCount: trs.length, colCount: maxCols, cells }],
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

function extractPreText(node: HtmlNode): string {
  let out = "";
  const visit = (n: HtmlNode | string): void => {
    if (typeof n === "string") {
      out += n;
      return;
    }
    if (n.tag === "br") {
      out += "\n";
      return;
    }
    for (const c of n.children) visit(c);
  };
  for (const c of node.children) visit(c);
  return out;
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
    lineSpacing: 160,
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
