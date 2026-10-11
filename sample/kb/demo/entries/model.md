# Sample KB: model

### demo.model.provider
claim: Cloudberry Lantern は架空のモデル「灯り」を利用する。
status: verified  # draft | verified | conflict | retired
verified: 2026-10-12
sources: S01#E11, S02#model
select: 利用AI=灯り; 提供元国=架空国
note: サンプルの承認済み項目。

### demo.model.region
claim: Cloudberry Lantern の処理地域は架空の北地域を予定している。
status: draft
sources: S01#E12

### demo.model.retention
claim: 保持期間について、資料には７日と１４日の異なる記載がある。
status: conflict
sources: S01#E13, S02#retention
note: サンプルの不一致を確認する。

### demo.model.legacy
claim: 旧モデル「小灯り」の利用は終了した。
status: retired
sources: S02#legacy
