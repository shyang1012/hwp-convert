# MEMORY — hwp-convert (포인터)

이 프로젝트의 메모리는 **bd(beads) 단일 원장**이다. 파일 메모리(본문 .md)는 쓰지 않는다 — 머신·계정 간 파편화 방지.

## 로드 (3단 포인터)
1. `bd prime` — 골격만(~1.7KB 고정, 메모리 본문 미주입). 상세: `.beads/PRIME.md`
2. `bd memories` — 인덱스(키 + 한 줄 요약). 검색 `bd memories <keyword>`
3. `bd recall <key>` — 개별 본문, 필요할 때만. 세션 요약은 `session-<YYYY-MM-DD>`, 최근 3개만 펼침

## 저장 / 정리
- `bd remember "<통찰>" --key <key>` (영속 통찰=의미 키, 세션 요약=`session-*`)
- `bd forget <key>` — 오래된 `session-*` 정리(보존 10건)

🔴 새 파일 메모리 생성 금지. 세션 진입은 `/시작`, 마무리는 `/종료` 가 위 흐름을 자동 수행.
