# 受け入れ：dek `b5db9910`

ct の `prove` の判定を、試作 `ctp` の段 1 と同じ題材と正解で確かめた記録です。

- 題材: dek main `b5db9910`。`dek-ctp`（dek の worktree）から `git archive b5db9910` で取り出し、作業用の場所で `git init` して 1 コミットにした。dek と `dek-ctp` には書き込んでいない
- 台帳: [`confidence/dek.yaml`](confidence/dek.yaml)。`dek-ctp` の `confidence/dek.yaml` を ct の形に書き直したもの。何を変えたかは、ファイルの先頭に書いた
- 正解: [`truth.yaml`](truth.yaml)。`dek-ctp` の `tools/ctp/experiments/truth.yaml` をそのまま写した。ctp を dek で動かす前に書かれたもの
- ct: この PR の `src/`
- Bun 1.4.4、macOS（arm64）

## 動かし方

```sh
git -C <dek> archive b5db9910 | tar -x -C <work>
cd <work> && git init -q && git add -A && git commit -qm "dek b5db9910"
bun install --frozen-lockfile
mkdir -p confidence && cp <ct>/acceptance/dek/confidence/dek.yaml confidence/
bun <ct>/src/cli.ts check
MISE_NODE_VERSION=24.22.3 MISE_RUMDL_VERSION=0.3.0 bun <ct>/src/cli.ts prove --json --timeout 300s > prove.json
bun <ct>/acceptance/compare.ts prove.json <ct>/acceptance/dek/truth.yaml
```

## 結果

3 回実行して、3 回とも同じ判定でした。

```
                      判定: held          判定: unreached     判定: survived      判定: undetermined
正解: held              2                 0                 0                 0
正解: unreached         0                 3                 0                 0
正解: survived          0                 0                 5                 0
正解: undetermined      0                 0                 0                 1

偽の保持: 0 件
食い違い: なし
```

| 回  | 所要時間 | テストの実行 |
| --- | -------- | ------------ |
| 1   | 27.9 秒  | 27 回        |
| 2   | 24.4 秒  | 27 回        |
| 3   | 24.3 秒  | 27 回        |

- 検出された壊し方は 4 つ（`rail-hidden` の「真にする」、`rail-key` の 2 つ、`rooms-keep-clamped`）。落ちたテストの失敗は、すべてアサーションの失敗だった。時間切れ、遅すぎ、2 回で食い違ったものは 0 件
- 正解のない `control#browser-reach`（到達だけの対照）は、3 回とも http だけで到達した。実ブラウザからの到達
- 届いた受け口（`via`）は回によって違った。Bun のプロセスからの http は、届かない回があった（file だけに届いたのは、1 回目の `rooms-keep-clamped` と `invalid-break`、3 回目の `rail-hidden-when-presenting` と `rooms-keep-clamped`。2 回目はすべて両方に届いた）。どの回も file には届いていたので、判定には効いていない

## 試作との違いで、判定に効きうるもの

- 生成した壊し方を当てた。試作は台帳の手書きの壊し方だけだった。たとえば `start#rail-hidden-when-presenting` には、項を落とす 2 つ、偽にする、真にするの 4 つが当たった（試作は 1 つ）。生存が 1 つでもあれば素通りなので、判定は変わらなかった
- `control#invalid-break` は `generate: false` で、手書きの無効な壊し方だけを当てた。生成を止めなければ、`return;` の壊し方で検出され、保持になる
- 到達は 1 回だけ測った。試作は 3 回
- 検出は、もう一度壊して、同じテストが時間切れ以外の理由で落ちたときだけ数えた
