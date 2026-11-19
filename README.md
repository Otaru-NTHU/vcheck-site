# V皮座談｜電腦檢測頁 v0.2

純靜態網站，沒有後端。整個資料夾放上 GitHub Pages 就能用。

## 上線（GitHub Pages）

1. 在 GitHub 建一個公開 repo（例如 `vcheck`）。
2. 把這個資料夾裡的**所有檔案**上傳到 repo 根目錄（含 `.nojekyll`、`vendor/`、`models/`）。
3. Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main` / `(root)`。
4. 一兩分鐘後網址是 `https://<帳號>.github.io/vcheck/`。

鏡頭需要 https，所以不能直接雙擊 `index.html` 開。本機測試請在這個資料夾執行
`python -m http.server 8000`，再開 `http://localhost:8000/`。

## 上線前要做的一件事

把臉部追蹤模型放進網站，避免講者的網路擋住 Google 的下載點：

- 下載 <https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task>
- 存成 `models/face_landmarker.task`

沒放也能運作，程式會自動改向 Google 下載。

## 可以調整的地方（都在 `app.js` 最上面的 `CONFIG`）

| 項目 | 說明 |
|---|---|
| `MODEL_URL` | 測試用的角色。換成自己的 VRM 就改這裡。 |
| `TIER` | 四個等級的門檻。目前是暫定值，收到真機數字後校正。 |
| `HEAD_SIGN` | 試玩時頭轉的方向若相反，把對應的值改成相反數。 |
| `REPORT_URL` | 填入網址後，結果會自動 POST 回傳（JSON）。留空只顯示。 |
| `LEVELS` | 三種畫質的解析度與陰影。 |

## 目前的限制

- 還沒有網路穿透測試（等中繼服務開好再加）。
- 等級門檻未經真機校正，畫面上標示為「初步」。
- 角色是站姿，尚未做坐姿。

## 範例模型授權

`models/sample.vrm` 是 pixiv/three-vrm 倉庫的範例模型 `VRM1_Constraint_Twist_Sample`
（© 2022 pixiv Inc.，VRM Public License 1.0，允許再散布）。正式使用時請換成自己的角色。
