# `/push` — 변경을 dev 브랜치에 push

아래 STEP 을 순서대로 실행하라. 자동 진행하되 각 STEP 한 줄 상태 출력.

## 🔴 STEP -1 — 브랜치 확인 (안전장치)

```bash
git branch --show-current
```
- `dev` 가 아니면 즉시 `git checkout dev` + `[STEP -1] {원래} → dev checkout 완료`
- 이미 dev 면 `[STEP -1] 현재 branch: dev (정합)`
- 🔴 commit log 추측으로 "main 직접 commit" 판단 금지. 룰 본문(/push=dev / /배포=main)이 1차 source.

## STEP 0 — untracked 분류

`git status --short | grep "^??"` 로 미등록 파일 분류:

| 그룹 | 기준 | 처리 |
|------|------|------|
| 포함 | `src/`, `test/`, `docs/`, `scripts/`, `.claude/`, 루트 설정(package.json·tsconfig·*.md) | `git add` |
| 제외 | `node_modules/`, `dist/`, `etc/`, `tmp/`, `.beads/dolt/`, `.npmrc`, `*.env*`, `*.key`, `*.pem` | skip |
| 확인 | 그 외 | 목록 출력 후 PM 확인 |

## STEP 1 — 변경 분류 + 커밋

`git status --short` 확인 → Conventional Commit prefix 선택:
`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`

```bash
git add -A            # 단, .npmrc·*.key·*.pem·*.env 민감 파일 제외(STEP 0 기준)
git commit -m "<prefix>: <요약>"
```

커밋 메시지 끝에:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## STEP 2 — dev push

```bash
git push origin dev
```

완료 출력:
```
[push 완료]
- 브랜치: dev
- 커밋: {해시} — {메시지}
```

## 주의

- `git push --force` / `git reset --hard` 금지.
- **운영 배포(main)는 `/배포`** — `/push` 는 dev 전용.
- working tree clean 이면 알리고 종료.
- conflict 시: 양쪽 commit timestamp 비교 → 최신 기준 `--theirs`/`--ours` 일괄 적용 → `git commit --no-edit` → push. 14건 이상 대규모거나 timestamp 역전이면 중단 + PM 보고.
