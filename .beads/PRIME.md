# hwp-convert — Beads 워크플로우 + 메모리 (prime 골격)

> 세션 복구: 압축/clear/새 세션 후 `bd prime` 재실행. 이 출력은 **골격만**이며 메모리 본문은 싣지 않는다(고정 크기).

## 🧠 메모리 체계 (3단 포인터 — 본문 자동주입 차단)
- 메모리 본문은 prime 에 주입하지 않는다. 인덱스/본문은 아래로 핀포인트 조회.
- **인덱스**: `bd memories` (키 + 한 줄 요약). 검색: `bd memories <keyword>`.
- **본문**: `bd recall <key>` — 필요할 때만 개별 조회.
- **세션 요약**: `session-<YYYY-MM-DD>` 키로 저장. 로드 시 **최근 3개만** recall, 나머지는 인덱스로만.
- **저장**: `bd remember "<통찰>" --key <key>` / **삭제**: `bd forget <key>`.
- 영속 통찰(정책·노하우)은 의미 키(`--key <topic>`), 세션 요약은 `session-*`.
- 🔴 파일 메모리(MEMORY.md 본문 등) 신규 생성 금지 — **bd 가 단일 메모리 원장**. `.claude/MEMORY.md` 는 이 프로토콜 포인터일 뿐.

## 📋 작업 추적 (bd)
- 모든 작업 추적은 bd: `bd ready`(착수 가능) / `bd create --type <task|bug|feature|chore|epic|decision> --title "..."` / `bd close <id>` / `bd note <id> "..."`.
- TodoWrite·마크다운 TODO 금지. 이슈 먼저 만들고 코딩, 시작 시 `bd update <id> --claim`.

## 🔧 Git / 세션
- `dev` = 일상 개발. `main` = 배포(`/배포`: e2e+PR). 세션 종료는 `/종료`.
- 🔴 명시 요청 없이 `main` push/머지 · `git push --force` · `git reset --hard` · `bd dolt push` 금지.
- 상세 정책: `AGENTS.md` / 아키텍처: `CLAUDE.md`.

## 🚀 세션 진입
`/시작` → STEP 0 메모리 로드(prime→memories→recall session 최근3) → 브랜치·`bd ready` 보고.
