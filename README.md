# 二枚舌の酒場

赤と青の陣営に分かれて、誰が味方かわからないままダイスの嘘を読み合う、陣営戦ライアーズダイス。
ブラウザで最大6人まで遊べて、足りない席はCPUが埋めます。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `server.js` | オンライン対戦サーバー（Express + Socket.IO）。ルーム管理と中継 |
| `public/engine.js` | ゲームのルールとCPUの思考。サーバーとブラウザで共通 |
| `public/index.html` | サーバーが配信する画面（`npm run build` で生成） |
| `client.template.html` / `client.js` / `base.css` | 画面のソース |
| `build.js` | 上の3つとエンジンから `public/index.html` と `standalone.html` を作る |
| `standalone.html` | CPU戦だけ遊べる1ファイル版（サーバー不要） |

`public/index.html` と `standalone.html` は `npm install` のときに自動で作り直されます（`postinstall`）。手元で画面を直して確認するときは `npm run build` を実行してください。

## 手元で動かす

Node.js 18 以上が必要です。

```
npm install
npm start
```

ブラウザで http://localhost:3000 を開きます。同じWi-Fiの別の端末からは `http://<このPCのIPアドレス>:3000` で参加できます。

## ネットに公開する（Render の場合）

1. このフォルダを GitHub のリポジトリにアップロードする（`node_modules` は含めない）。
2. https://render.com でアカウントを作り、New → Web Service でそのリポジトリを選ぶ。
3. 設定は次の通り。
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free で可
4. デプロイが終わると `https://〇〇.onrender.com` のURLが発行される。そこを開いて「ルームを作る」→招待リンクを共有。

GitHubに変更をpushすると、Renderが自動で再ビルド・再デプロイします（Auto-Deploy が既定でオン）。
ビルド時に `npm install` が走るので、`client.js` などを直しただけでも画面に反映されます。

注意点：
- 再デプロイの瞬間にサーバーが入れ替わるので、遊んでいる最中にpushすると進行中のゲームは消えます。
- 無料プランは15分ほどアクセスがないと眠り、次のアクセスで起動に30秒〜1分かかります。遊ぶ前に一度開いておくと安心です。
- ルームはサーバーのメモリにだけ保存しています。サーバーが再起動すると進行中のゲームは消えます。
- Railway や Fly.io でも同じ手順（`npm install` → `npm start`、ポートは環境変数 `PORT`）で動きます。

## オンライン時の制限時間

ロビーでホストが選べます（選択肢は `server.js` の `TIMER_OPTS`）。時間切れや切断中の人の手番は、CPUが代わりに打ちます。

| 場面 | 既定 |
|---|---|
| 宣言の手番 | 60秒 |
| ラウンド準備 | 45秒 |
| 待ったの判断 | 15秒 |
| 密談の相手選び | 30秒 |
| 密談 | 180秒 |
| 告発 | 90秒 |

## 看破ボーナスの調整

ダウトで嘘を見破ったとき、宣言が実際の個数より `bonusGap` 個以上多ければ、嘘をついた側から追加で `bonus` 枚を奪います（既定は3個以上で2枚）。
`server.js` の `createGame({...})` に `bonusGap` と `bonus` を渡すと変えられます。

## 途中で抜けた・リロードした

同じブラウザで同じURL（`?room=コード` 付き）を開き直せば、席とログが戻ります。
