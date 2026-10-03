# GitVault

Android (Pixel) 向けの、オフラインで使える Obsidian 風 Markdown ノート PWA。保存先は GitHub リポジトリ。

- `[[wikilink]]`（補完つき）、バックリンク、`#tag`、タスクのチェック、全文検索、クイックスイッチャー、デイリーノート
- 編集モード（CodeMirror 6）と閲覧モードの切り替え。キーボード上のツールバー
- 完全オフライン動作（App Shell は Service Worker、ノートは IndexedDB）

## 保存体験の設計

**「保存」は 2 層に分かれていて、ユーザーが意識するのは前者だけ**という設計にしています。

| 層 | タイミング | 失敗時 |
|---|---|---|
| 端末への保存（IndexedDB） | 入力のたびに即メモリへ、400ms のデバウンスで IndexedDB へ | — （ローカルなので失敗しない前提） |
| GitHub への同期（commit） | 下記トリガーで、**未同期の変更すべてを 1 コミットにまとめて** push | 端末に残り、次のトリガーで再試行 |

同期トリガー:

1. **アプリを離れたとき**（`visibilitychange → hidden`：アプリ切り替え・画面オフ）。モバイルでは編集セッションが短いので、これが主なトリガーになる
2. **編集が止まってから N 秒**（既定 2 分、設定で 30 秒 / 5 分 / オフを選択）。長い編集中でも他の端末へ反映されるようにする
3. **オンライン復帰時**、**起動時・復帰時**（前回から 30 秒以上経っていれば pull を兼ねる）
4. **ステータスチップをタップ**（手動）
5. **Background Sync**：離脱時やオフライン時に登録しておき、ページが凍結・終了されても接続が戻った時点で Service Worker が同期する（Chrome for Android）

ヘッダーのチップに状態を常時表示します: `✓ 2分前` / `● 3件未同期` / `オフライン · 3件待機` / `⚠ 同期エラー`。

### 採用しなかった案

- **保存のたびに push**：コミット履歴が細切れになり、API 呼び出しとバッテリーも無駄
- **保存ボタンで push**：押し忘れると他端末に反映されない。モバイルではアプリが予告なく終了される
- **同一セッション中のコミットを amend して force push**：履歴はきれいになるが、`PATCH ref` は compare-and-swap ではないので、他端末の push と競合すると消してしまう危険がある

## 同期アルゴリズム

ノートごとに 3 つの版を git の blob SHA で比べます（`src/lib/sync.ts`）。

- **base**：前回この端末とリモートが一致した版（`bases` ストア。3-way マージの共通祖先にもなる）
- **local**：端末上の現在の版
- **remote**：ブランチ先頭の版

| local | remote | 処理 |
|---|---|---|
| 未変更 | 変更 | pull |
| 変更 | 未変更 | push |
| 変更 | 変更（同内容） | base を更新するだけ |
| 変更 | 変更（異なる） | 行単位の 3-way マージ。クリーンならマージ結果を push、衝突したらリモート版を元のパスに置き、自分の版を `ノート (conflict 端末名 日時).md` として残す |
| 削除 | 変更 | 変更を優先して復元 |
| 変更 | 削除 | 変更を優先して再追加 |

- push は Git Data API（tree → commit → ref の fast-forward 更新）。他端末が先に push していたら（422）最初からやり直すので、force push はしない
- リモートの先頭が前回同期時から変わっていなければ、`GET ref` 1 回だけで終わる
- 同期中にユーザーが同じノートを編集した場合、`rev` による compare-and-set で上書きを防ぎ、次回の同期で整合させる
- 同期は Web Locks で直列化するので、複数タブと Service Worker が同時に走らない
- 同期対象は `.md` / `.markdown` / `.txt` だけ。`.obsidian/` などのドットフォルダや画像はリモートにそのまま残る（`base_tree` を使うため消さない）

## セットアップ

```sh
npm install
npm run dev        # http://localhost:5173
npm test
npm run build
```

### デプロイ（GitHub Pages）

このアプリ自体を GitHub に push すると、`.github/workflows/pages.yml` がテスト・ビルドして Pages に公開します（リポジトリの Settings → Pages → Source を "GitHub Actions" にしておく）。Pixel の Chrome で公開 URL を開き、メニューの「アプリをインストール」でホーム画面に追加してください。

### ノート用リポジトリとトークン

1. ノート用のリポジトリを作る（private 推奨。空でもよい）
2. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** で、そのリポジトリだけを対象に **Contents: Read and write** を付けて発行する
3. アプリの初回画面でオーナー・リポジトリ・ブランチ・トークンを入力する

## 制約・トレードオフ

- **認証は PAT のみ**：GitHub の OAuth（Device Flow を含む）のトークン交換エンドポイントは CORS 非対応で、ブラウザだけでは完結しない。OAuth にするには小さなプロキシ（Cloudflare Workers など）が要る
- **トークンは IndexedDB に平文で保存**される。Markdown は DOMPurify でサニタイズしているが、XSS が起きれば読まれうる。権限を 1 リポジトリ・Contents のみに絞ることが前提
- 画像などの添付ファイルは未対応（同期対象外。表示もしない）
- リネームは「削除 + 追加」として扱い、他ノートのリンクは書き換えない
- リポジトリのツリーが GitHub API の上限（約 10 万エントリ）を超えると同期できない
- CRLF のノートを編集すると LF に正規化される（CodeMirror の仕様）
