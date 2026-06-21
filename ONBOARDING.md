# Welcome to hwp-convert

## How We Use Claude

Based on ssabro's usage over the last 30 days:

Work Type Breakdown:
  Debug Fix       ████████████░░░░░░░░  60%
  Build Feature   ██████░░░░░░░░░░░░░░░  30%
  Improve Quality ██░░░░░░░░░░░░░░░░░░░  10%

Top Skills & Commands:
  /init     ████████████████████  1x/month
  /doctor   ████████████████████  1x/month

Top MCP Servers:
  hwp        ████████████████████  32 calls
  Multi-CLI  █░░░░░░░░░░░░░░░░░░░░  2 calls

## Your Setup Checklist

### Codebases
- [ ] hwp-convert — https://github.com/shyang1012/hwp-convert (이 프로젝트, npm `hwp-convert`)
- [ ] hwpxjs — https://github.com/ssabro/hwpxjs (fork 출처, MIT — 참고용)

### MCP Servers to Activate
- [ ] hwp — 한글(한컴오피스) 문서를 실제로 열고/읽고 표·이미지를 검증하는 MCP. **변환 결과가 한글에서 진짜 열리는지** 확인하는 핵심 도구(이 프로젝트에서 32회 사용). 로컬에 한글 프로그램 + hwp MCP 서버 설정 필요(PM에게 설정 경로 문의).
- [ ] Multi-CLI — Codex/Gemini 를 MCP 로 직접 호출(plan/code 리뷰·audit). `List-Codex-Models`/`List-Gemini-Models` 후 `Ask-Codex`/`Ask-Gemini`.

### Skills to Know About

프로젝트 커스텀 커맨드 (`.claude/commands/`, code-wiz 기반 → hwp-convert 맞춤):
- [ ] /시작 — 세션 컨텍스트 로드(AGENTS 정책 + git + `bd ready`). 작업 시작 시.
- [ ] /push — 변경을 `dev` 브랜치에 커밋·push. 평소 백업.
- [ ] /배포 — `dev→main` e2e 점검 + PR + `npm publish`. PM 이 배포 결정 시.
- [ ] /종료 — beads 동기화 + 로컬 커밋 + 세션 요약. 작업 마무리 시.

글로벌 스킬(`~/.claude`, 모든 프로젝트 공통):
- [ ] /계획리뷰 — 구현 전 계획서를 Codex audit + (옵션) Gemini 통찰로 검증.
- [ ] /리뷰 · /감사 — 코드 변경 리뷰 / 기술 감사.

기본 커맨드:
- [ ] /init — 코드베이스 분석 → CLAUDE.md 생성. 새 repo 합류 시 한 번.
- [ ] /doctor — Claude Code 환경 진단. 동작이 이상할 때.

## Team Tips

- **dev/main 분리** — 평소 모든 작업·커밋은 `dev`. `main` 은 배포 전용이라 직접 push 금지. 백업은 `/push`(dev).
- **배포는 e2e + PR + publish** — PM 이 배포를 결정하면 `/배포`: 대표 경로 e2e 점검 → `dev→main` PR → `npm version` → `npm publish`. 임의 main 머지 금지.
- **변환은 한글로 검증** — 이 프로젝트의 핵심 교훈: 자체 `HwpxReader` round-trip 테스트가 통과해도 한컴에서 안 열릴 수 있다. 변환 산출물은 hwp MCP(`hwp_open_document` + `hwp_get_tables`)로 **실제 한글에서 열어** 확인한다.
- **이슈는 beads** — TodoWrite 대신 `bd`. 세션은 `/시작`·`/종료` 로 컨텍스트·핸드오프 관리.
- **출처 유지(MIT)** — hwpxjs·rhwp fork 이므로 `LICENSE`/`NOTICE` 의 저작권 고지, 포팅 파일 헤더 출처 주석을 절대 지우지 말 것.
- **보안** — `.npmrc`(npm 토큰)·`.env`·키 파일은 커밋·노출 금지(`.gitignore`+`.claudeignore` 로 차단됨). npm 토큰은 만료형 사용.
- **브라우저 안전** — 코어(`src/lib`)는 Node 전용 API(`fs`/`path`/`Buffer`) 금지. Node 전용 로직은 `cli.ts` 또는 주입(`imageResolver`)으로.

## Get Started

1. `/시작` 으로 컨텍스트를 로드하고 `bd ready` 로 착수 가능한 작업을 확인한다.
2. 환경 점검: `npm install && npm run build && npm test` (109+ 통과 확인).
3. 변경은 `dev` 에서 작업하고 `/push` 로 백업. 배포가 필요하면 PM 확인 후 `/배포`.
4. 후속 작업 후보(원하면 첫 작업으로): 다중 섹션 페이지설정 보존(HWP→HWPX), 이미지 원본 픽셀 비율 보존(PNG/JPG 헤더 파싱).

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
