# 人が行う操作の案内

[動画と手順のページ](index.html)をパソコンで開くと、必要な章から確認できます。GitHub 上では HTML をそのまま再生できないため、リポジトリを取得してから開いてください。AI に「操作の案内を開いて」と頼むか、`node dist/cli.js guide` で場所を表示できます。

**8 章の匿名化済み動画を視聴できます。第 07 章は準備中です。** 操作の一部だけを収録した章は、動画を見る前にその範囲を表示します。登録・認証・支払情報の入力など、未収録の操作もあります。

| 操作 | 使うとき | 収録範囲 | 動画 |
|---|---|---|---|
| [LINE のチャネル ID・シークレット・トークン](index.html#line-messaging-api) | L Harness の新規作成 | 既存チャネルの ID・シークレット・既存トークンの確認とコピー。新規作成・再発行は含まない | [MP4](videos/01-line-messaging-api.mp4) |
| [LINE ログインの ID・シークレット](index.html#line-login) | L Harness のログイン準備 | 既存ログインチャネルの ID・シークレットの確認とコピー。チャネル作成・コールバック設定は含まない | [MP4](videos/02-line-login.mp4) |
| [LIFF アプリの作成・ID](index.html#liff) | LINE 内の画面の準備 | 入力・作成・ID のコピーと、配備後の実 URL への変更・更新・再表示の確認 | [MP4](videos/03-liff.mp4) |
| [Cloudflare の登録・メール認証](index.html#cloudflare-account) | アカウントがない場合 | ログイン済みプロフィールのメール「確認済み」の確認だけ。登録の入力画面・最終送信・メール内リンクの操作は未収録 | [MP4](videos/04-cloudflare-account.mp4) |
| [Cloudflare R2 の有効化](index.html#cloudflare-r2) | 画像保存先の準備 | メニューを開き、有効化済み画面を確認。支払情報の入力・有効化の最終操作は未収録 | [MP4](videos/05-cloudflare-r2.mp4) |
| [Cloudflare の接続許可・API トークン](index.html#cloudflare-api-token) | ツールの接続準備 | カスタムトークンの権限 5 項目・対象の下書きと確認画面。最終発行・値の表示・通常の接続許可は含まない | [MP4](videos/06-cloudflare-api-token.mp4) |
| [接続情報をファイルへ保存](index.html#save-credentials) | 値の貼り付けを求められた場合 | 空欄の見本への貼り付け・保存の実演。値は説明用の伏せ字で、実際の秘密値の編集は画面に表示しない | 収録・確認中 |
| [Lステップのログイン・取得元の確認](index.html#lstep-login) | 管理画面からの取得（2026年11月4日時点で使えません） | ログイン済み画面の上部で取得元を確認する操作だけ。ログイン情報の入力・認証・取得専用 Chrome のウィンドウは未収録 | [MP4](videos/08-lstep-login.mp4) |
| [移行後の管理画面を確認](index.html#migration-review) | 投入・照合の完了後 | 管理画面へ API キーでログインし、移行後の画面を確認する実演。投入前の承認や全機能の動作試験は対象外 | [MP4](videos/09-migration-review.mp4) |

L Harness をすでに使っている場合、LINE 接続情報の取得・LIFF の新規作成・Cloudflare の登録をやり直す必要はありません。移行先は、Lステップと同じ LINE 公式アカウントであることを確認してください。

動画のアカウント名・ID・秘密の値は隠し、全編を確認しています。実際の値は、ご自身の画面から指定された保護されたファイルに保存してください。AI のチャットや公開用のファイルには貼り付けません。支払情報の入力や規約への同意は、ご自身で行ってください。

動画に映る各サービス（LINE Developers・Cloudflare・Lステップ・L Harness）の画面・ロゴ・名称の権利は、それぞれの提供元にあります。動画は操作手順を説明するためだけに収録したもので、このリポジトリの MIT License はこのツールのコードと文章に対するものです。画面やロゴを切り出して別の用途に使わないでください。

## LINE の値と保存先

画面の表示言語により、日本語と英語の表記が変わります。Messaging API と LINE ログインには、それぞれ別のチャネル ID とシークレットがあります。

| 取得するチャネル | 画面の項目 | 保存する欄 |
|---|---|---|
| Messaging API | チャネル ID / Channel ID | `LINE_CHANNEL_ID` |
| Messaging API | チャネルシークレット / Channel secret | `LINE_CHANNEL_SECRET` |
| Messaging API | チャネルアクセストークン / Channel access token | `LINE_CHANNEL_ACCESS_TOKEN` |
| LINE ログイン | チャネル ID / Channel ID | `LINE_LOGIN_CHANNEL_ID` |
| LINE ログイン | チャネルシークレット / Channel secret | `LINE_LOGIN_CHANNEL_SECRET` |
| LINE ログイン内の LIFF | LIFF ID | `LIFF_ID` |

この LIFF の収録例では、既存友だちの移行テストとして Full・`openid` / `profile`・友だち追加 Off を使用しています。作成時の `https://example.com` は仮の値で、配備後に案内されたエンドポイント URL に `?liffId=<LIFF_ID>` を付けた値へ変更し、更新・再表示で確認する場面も収録しています。`<LIFF_ID>` はご自身の ID に置き換えます。使う L Harness の案内に合わせて設定してください。友だち追加 Off をすべての利用者に勧めるものではありません。

[LINE 接続情報の空欄の見本](line-setup.env.example)には、上の 6 項目だけが入っています。第 07 章はこの見本への貼り付け・保存を、説明用の伏せ字で実演します。実際の値は、公開用の見本ではなく AI が案内する保護された保存先に保存してください。移行ツールの `.env` に入れる `HARNESS_API_KEY` は、L Harness の API Key で、この見本とは別に扱います。

## 動画を追加・更新する人へ

- 公開用の動画だけを `videos/` に置きます。未加工の録画・書き出した接続情報・作業中の画像を、このリポジトリへ置かないでください。
- `chapters.js` のファイル名に合わせた MP4 を使います。ブラウザで再生できる H.264、画面の文字を読める解像度を維持し、音声が不要なら含めません。
- 全編の個人情報・アカウント情報・秘密の値と、字幕・音声・ファイル情報を確認してから、該当章の `reviewed` を `true` にし、`recordedAt` に収録日を入れます。
- `coverageNote` は、収録した操作と未収録の操作を区別して書きます。動画の上に常時表示されるため、最終操作を撮っていない章を、全操作の録画として案内しないでください。
- 日本語字幕を別ファイルで付ける場合は WebVTT を置き、該当章の `captions` に相対パスを指定できます。
- この一覧の「準備中」を、確認した動画へのリンクへ置き換えます。元サービスの画面が変わったら、収録日と手順も更新してください。

章 ID は `line-messaging-api`・`line-login`・`liff`・`cloudflare-account`・`cloudflare-r2`・`cloudflare-api-token`・`save-credentials`・`lstep-login`・`migration-review` です。`guide <章ID>` で、その章を指定できます。

収録の出典と公開前の確認方針は [RECORDING.md](RECORDING.md) にあります。
