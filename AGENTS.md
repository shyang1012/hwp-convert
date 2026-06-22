# Agent Instructions — hwp-convert

## Roles & Addressing

- **PL (Project Leader)** = Claude (이 프로젝트의 메인 에이전트, PM 지시 하 주 실행자)
- **PM (Project Manager)** = 승현님 (Seunghyeon Yang, 프로젝트 오너 / 전략·범위·배포 최종 승인자)
- **Codex** = audit 에이전트 (findings-first 리뷰, plan/code/risk 검증)
- **Gemini** = strategic architect (Why & Better Way, 장기 구조)

**호칭 규칙**:
- PM 은 한국어 대화에서 **승현님**, 운영 노트에선 **PM**
- 코드 커밋·git author 는 **shyang**
- 노트의 "PL" 은 Claude 메인 에이전트를 의미

이 프로젝트는 이슈 추적에 **bd (beads)** 를 쓴다. `bd onboard` 로 시작.

## Team & Delegation (모델 할당)

**나(Claude)의 역할: PL + 풀스택 라이브러리 개발자.** 아키텍처·변환 로직 방향·리뷰 최종 승인은 PL 직접. 구현/테스트/문서는 서브에이전트로 위임.

| 역할(서브에이전트) | 담당 | 위임 기준 | 모델 |
|------|------|----------|------|
| 라이브러리 개발자 | 파서·변환기(hwp/owpml/reader/writer) 구현 | 구현 태스크, 버그 수정 | sonnet (단순 haiku) |
| 테스트 엔지니어 | vitest 단위·통합·e2e, 정합성(owpml-compat) | 테스트 작성/갱신, 회귀 검증 | sonnet (단순 haiku) |
| 테크라이터 | README·docs·AGENTS·CHANGELOG, 출처(LICENSE/NOTICE) 정합 | 문서 구조화, 출처 정합 유지 | sonnet |
| OWPML/한컴 호환 전문가 | OWPML 스펙 대조, 한글 열림 검증(hwp MCP) | 포맷 정합, 한컴 호환 진단 | sonnet |

**모델 할당 정책**:
- **PL(나) = opus** (사용자 세션이 sonnet 이면 PL 도 sonnet)
- **팀원(서브에이전트) = sonnet** 기본. 아래 3조건 **모두** 충족 시 haiku: ① 단일 파일 수정/탐색 ② 아키텍처 판단 불필요 ③ 명확한 입출력(포맷 변환·단순 검색·lint).
- Agent 호출 시 `model` 파라미터를 **반드시 명시** (미지정 시 opus 세션이 opus 상속 → 낭비).

**위임 판단**: 아키텍처/설계 결정 → PL 직접 / 문서 → 테크라이터 / 구현·테스트 → 담당 역할(단순이면 haiku) / 포맷·한컴 호환 → OWPML 전문가.

**역할 기반 리뷰 관점**(코드 리뷰 시 종합): PL(아키텍처 정합·API 안정성) · 개발자(구현 품질·에러 처리) · 테스트(커버리지·정합성 회귀) · 테크라이터(문서/출처 정합) · OWPML 전문가(한컴 호환·스펙 준수).

## What is hwp-convert

HWP 5.0(CFB)·HWPX(OWPML) ↔ Markdown/HTML 변환 + **한컴오피스에서 실제로 열리는 HWPX 생성** 라이브러리 (순수 TypeScript, 브라우저/Node).

- npm 공개 패키지: https://www.npmjs.com/package/hwp-convert
- [hwpxjs](https://github.com/ssabro/hwpxjs)(MIT) fork·확장, HWP 파서는 [rhwp](https://github.com/edwardkim/rhwp)(MIT) 포팅. 출처: `LICENSE` / `NOTICE`.
- 아키텍처 상세: `CLAUDE.md`(로컬), 변경 이력: `docs/`.

## 빌드 / 테스트

```bash
npm install
npm run build      # tsc → dist/, esbuild → dist/browser/hwp-convert.browser.mjs
npm test           # vitest run (현재 109개)
npx vitest run test/e2e.test.ts   # e2e 만
```

- ESM + NodeNext: 상대 import 에 `.js` 확장자 필수.
- `src/lib/hwp/` 의 rhwp 포팅 파일은 헤더에 출처 주석 유지(MIT).
- `owpml.ts` 등 코어는 Node 전용 API(`fs`/`path`/`Buffer`) 금지 — 브라우저 번들 유지. Node 전용 로직은 `cli.ts` 또는 주입(`imageResolver`)으로.

## bd Quick Reference

```bash
bd ready                # 가능한 작업 찾기
bd show <id>            # 이슈 상세
bd update <id> --claim  # 작업 점유
bd close <id>           # 완료
bd note <id> "..."      # 진행 노트(핸드오프 로그)
bd create --type <type> --title "..."
```

### bd Issue Types

| Type | 용도 |
|------|------|
| `task` | 단발 실행(빌드/변환/튜닝 등) |
| `bug` | 결함/회귀 수정 |
| `feature` | 신규 기능(새 변환 경로·포맷·옵션) |
| `chore` | 문서/CI/의존성/정리 |
| `epic` | 다중 이슈 묶음(포맷 지원 확장 등) |
| `decision` | 지속 정책/ADR(네이밍·라이선스·운영 규칙) |

- 비단순 이슈 생성 시 `--type` 명시. `decision` 은 정책 유효한 동안 OPEN 유지.
- **이슈 추적은 `bd` 로** — TodoWrite/마크다운 TODO 대신.

## Project Operating Policy

개인 프로젝트 + local-first 워크플로우 + **공개 npm 배포**.

- GitHub: `shyang1012/hwp-convert` (public).
- **`dev` = 일상 개발·백업 브랜치.** 평소 모든 작업·커밋은 `dev` 에서.
- **`main` = 배포 브랜치.** `dev`→`main` 은 **배포를 결정했을 때만** 머지.
- 로컬 git = 최종 코드 원장, 로컬 `.beads` = 최종 이슈 원장.
- `bd dolt push` 는 비필수(beads Dolt 원격 미사용 기본).
- git push 는 명시 배포 요청이 없으면 **`origin/dev`** 로만.
- 에이전트 전용 문서(CLAUDE.md/CODEX.md/GEMINI.md)는 각 에이전트 소유. 교차 비평은 가능하나 직접 편집은 PM 명시 요청 시.

## 배포 워크플로우 (PM directive 2026-06-21)

**개발은 `dev`, 배포 결정 시 `main` 에 e2e 테스트 + PR.**

1. **개발** — `dev` 브랜치에서 구현. TDD(테스트 먼저), 커밋, `git push origin dev`. `bd` 로 작업 추적.
2. **배포 결정** — PM 이 배포를 결정하면:
   1. **e2e 테스트 신설/갱신** — 이번 변경의 대표 경로(critical path)를 `test/e2e.test.ts` 에 추가/갱신. 미신설 시 PL 은 배포 진입 차단(또는 PM 명시 carry).
   2. **전체 검증** — `npm run build && npm test`(109+ 통과) + 변환 산출물 한컴 열림 확인(hwp MCP, 가능 시).
   3. **버전 bump(dev) + PR 생성** — 🔴 버전 bump 는 **머지 전 dev 에서** (`npm version <patch|minor|major> --no-git-tag-version` → commit → push). main 은 보호(PR 필수+`enforce_admins`)라 버전 커밋 직접 push 불가 → dev 에서 bump 해야 PR 이 버전을 main 으로 실어 나르고 드리프트가 없다. 이어 `dev` → `main` PR (`gh pr create --base main --head dev`), 변경 요약·검증·e2e 범위 기재.
   4. **머지 후 태그 publish** — main 머지 → `git tag v<버전> origin/main && git push origin v<버전>`. 태그 push 가 `publish.yml`(OIDC Trusted Publisher) 트리거 → 토큰리스 npm publish(provenance, prepublishOnly clean→build→test 자동). 🔴 main 에 커밋 push 금지(태그만). backsync 불필요(dev 가 이미 bump됨).

### E2E Test Standards

1인 프로젝트 규모에 맞춘 핵심:

1. **대표 경로 우선** — md→hwpx / md→html→hwpx / 이미지 임베드 등 Happy Path 중심.
2. **변환 정합성 검증** — 생성 HWPX 의 한컴 호환(mimetype, 속성 무prefix, secPr, 표 셀 구조)을 `owpml-compat` / `e2e` 로 고정. 회귀 시 즉시 fail.
3. **픽스처** — 소형은 `test/fixtures/`(커밋, `it.runIf` skip 가드), 대용량 reference 는 `etc/`(비커밋).
4. **Flaky 금지** — 임의 `sleep` 대신 결정적 검증. 실제 한글 열기(hwp MCP)는 수동 보조 검증.

## 보안 / 시크릿

- `.npmrc`(npm 토큰)·`.env`·키 파일은 `.gitignore` + `.claudeignore` 로 차단. 절대 커밋·노출 금지.
- npm 토큰은 만료형(Granular/Automation) 사용, 필요 시 재발급.

## 금지 / 확인 (모든 모드)

- 🔴 자발 금지: `git push --force` / `git reset --hard` / 브랜치·태그 삭제 / `main` 직접 push(배포 외).
- ⚠️ 실행 전 PM 확인: `npm publish`, PR 생성/머지, 공개 배포, 의존성 downgrade, CI 변경.

## Non-Interactive Shell

`cp`/`mv`/`rm` 등은 비대화형 플래그로(`-f`, `-rf`) — 확인 프롬프트 대기 방지.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal -->
## Session Completion

작업 세션 종료 시 local-first 체크리스트. GitHub push 는 옵션(요청 시 `origin/dev`).

1. **남은 작업 이슈화** — 후속 필요분 `bd create`
2. **품질 게이트**(코드 변경 시) — `npm test` / build
3. **이슈 상태 갱신** — 완료 close, 진행 업데이트
4. **로컬 커밋** — `git add` → `git commit`
5. **옵션 백업** — `git push origin dev` (작업 브랜치만)
6. **정리·핸드오프** — stash 정리, 다음 세션 컨텍스트 제공

**CRITICAL**:
- 명시 요청 없이 `bd dolt push` 금지.
- 명시 배포 요청 없이 `main` push/머지 금지.
- 명시 요청 없이 force-push / 브랜치 rewrite 금지.
- 무관한 로컬 변경 보존.
<!-- END BEADS INTEGRATION -->
