/**
 * OWPML(HWPX) 패키지 생성 공통 헬퍼.
 *
 * writer.ts(평문) 와 hwpxBuilder.ts(IR) 가 공유하는 OWPML 컨벤션 상수·유틸.
 * 기준: 한컴 정상 출력 샘플 etc/hwpxcore_test/ (header.xml / section0.xml).
 *
 * OWPML 핵심 규칙:
 *   - mimetype = "application/hwp+zip" (한글의 HWPX 매직 문자열)
 *   - 요소만 네임스페이스 prefix(hp:/hh:/hc:), 속성은 prefix 없음
 *   - head/sec/package 루트에 풀 네임스페이스 선언
 *   - 첫 문단에 <hp:secPr> (페이지 설정) 필수
 *
 * 순수 문자열·로직만 — Node 전용 API(Buffer/fs/path/crypto) 금지 (브라우저 ESM 번들 유지).
 * [shyang 2026-06-21]
 */

import type { HwpPageDef } from "./types.js";

/** mimetype 파일 내용 — 한글이 HWPX 를 감지하는 매직 문자열. */
export const MIMETYPE = "application/hwp+zip";

/** head/sec/package 루트가 공유하는 OWPML 풀 네임스페이스 선언. */
export const OWPML_NS =
  `xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" ` +
  `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ` +
  `xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" ` +
  `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ` +
  `xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ` +
  `xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ` +
  `xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" ` +
  `xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" ` +
  `xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" ` +
  `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
  `xmlns:opf="http://www.idpf.org/2007/opf/" ` +
  `xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" ` +
  `xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" ` +
  `xmlns:epub="http://www.idpf.org/2007/ops" ` +
  `xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"`;

/** 한 문단 라인세그 기본값(한컴 호환). 속성 prefix 없음. */
export const DEFAULT_LINESEG =
  `<hp:linesegarray>` +
  `<hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/>` +
  `</hp:linesegarray>`;

/**
 * 섹션 첫 문단에 들어가는 <hp:secPr>(페이지 설정) + <hp:ctrl><hp:colPr> 블록 생성.
 *
 * pageDef 가 있으면 용지(width/height)·여백(margin)을 그 값으로 출력하고,
 * 없으면 한컴 A4 세로 기본 프리셋(etc/hwpxcore_test/Contents/section0.xml 기준).
 * 그 외(grid/startNum/visibility/각주·미주/페이지테두리/colPr)는 현행 고정 — 한글이 열 때 재계산.
 * landscape 속성은 1차 보존 범위 밖이라 항상 "WIDELY"(가로/세로는 width<height 로 자연 표현).
 */
export function buildSecPr(pageDef?: HwpPageDef): string {
  const width = pageDef ? pageDef.width : 59528;
  const height = pageDef ? pageDef.height : 84186;
  const left = pageDef ? pageDef.left : 8504;
  const right = pageDef ? pageDef.right : 8504;
  const top = pageDef ? pageDef.top : 5668;
  const bottom = pageDef ? pageDef.bottom : 4252;
  const header = pageDef ? pageDef.header : 4252;
  const footer = pageDef ? pageDef.footer : 4252;
  const gutter = pageDef ? pageDef.gutter : 0;
  return (
    `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
    `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>` +
    `<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
    `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
    `<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>` +
    `<hp:pagePr landscape="WIDELY" width="${width}" height="${height}" gutterType="LEFT_ONLY">` +
    `<hp:margin header="${header}" footer="${footer}" gutter="${gutter}" left="${left}" right="${right}" top="${top}" bottom="${bottom}"/>` +
    `</hp:pagePr>` +
    `<hp:footNotePr>` +
    `<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>` +
    `<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>` +
    `<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/>` +
    `<hp:numbering type="CONTINUOUS" newNum="1"/>` +
    `<hp:placement place="EACH_COLUMN" beneathText="0"/>` +
    `</hp:footNotePr>` +
    `<hp:endNotePr>` +
    `<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>` +
    `<hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/>` +
    `<hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/>` +
    `<hp:numbering type="CONTINUOUS" newNum="1"/>` +
    `<hp:placement place="END_OF_DOCUMENT" beneathText="0"/>` +
    `</hp:endNotePr>` +
    `<hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>` +
    `<hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>` +
    `<hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>` +
    `</hp:secPr>` +
    `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>`
  );
}

/**
 * 하위호환 기본 secPr(페이지 설정 없는 경로 — 평문 writer.ts 등).
 * `buildSecPr()` 무인자 호출과 바이트 동일 → 기존 import·회귀 테스트 유지.
 */
export const SEC_PR_XML = buildSecPr();

let paraIdCounter = 0;

/**
 * 문단 고유 id 생성. 한컴은 <hp:p> 에 고유 정수 id 를 요구한다.
 * 결정적(카운터 기반) — 같은 문서/세션 내 고유하면 충분.
 */
export function makeParaId(): number {
  paraIdCounter = (paraIdCounter + 1) >>> 0;
  return paraIdCounter;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
