# 移行先のスキーマ

- `line-harness-bootstrap.sql`：[line-harness-oss](https://github.com/Shudesu/line-harness-oss) の `packages/db` が生成する移行先のスキーマです。`init-db` で試験用データベースを作るときと、自動試験で使います。line-harness-oss のコミット `5a9cf115b024`（2026-09-02）の `packages/db/bootstrap.sql` と同じ内容です。MIT License（Copyright (c) 2026 Shudesu）。全文は [LICENSE.line-harness-oss](LICENSE.line-harness-oss)。
- 移行先の L Harness を更新した場合は、同じ版のスキーマに差し替えてから試験してください。
