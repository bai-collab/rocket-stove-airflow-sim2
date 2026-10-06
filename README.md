# Rocket Stove Airflow Sim 2

Physics v3 / VGPU 重構版。

來源專案：`bai-collab/rocket-stove-airflow-sim`

本專案採 **CPU reference first**：先建立可驗證的 Physics v3 燃料轉化模型，再依序整合既有二維氣流，最後遷移到 VGPU/WebGPU。

## Physics v3 核心

- 有限稻稈燃料，不再使用無限火源
- `rawStraw -> char + volatileGas` 熱裂解
- 熱裂解由溫度驅動，不要求充分氧氣
- 揮發性氣體依溫度、氧氣、混合度進行燃燒
- 不良燃燒條件提高相對黑煙生成
- 黑煙只有在高溫、含氧、充分混合並具有停留時間時才可進一步氧化
- `char` 在高溫、有氧時可進一步氧化
- 灰分來自獨立 `mineralMatter` 儲量被顯現，不把碳描述為直接變成灰
- 有機物與礦物質分開做守恆診斷
- tracer 僅視覺化氣流，不決定氧氣或燃燒

## 已完成的第一個里程碑

- CPU reference fuel transformation model
- `rawStraw / char / volatileGas / smoke / mineralMatter / ash` 狀態
- carbonization metrics
- Node built-in physics tests
- VGPU backend、device-local Physics v3 與直接 WebGPU 呈現
- WGSL `pyrolysis` / `volatile combustion` / `char oxidation` / `secondary combustion` 模組
- GPU tracer 掃掠碰撞與 scalar outflow reduction
- GPU 黑煙／揮發氣體／尾氣傳輸的 mass reduction 與守恆校正
- CPU／GPU 燃料參數共用 `DEFAULT_FUEL_PARAMS`

## 執行測試

```bash
npm test
npm run typecheck
npm run check:wgsl
npm run test:gpu
npm run build
```

`npm run test:gpu` 需要可用的 Dawn/WebGPU adapter；命令內含 adapter smoke test，沒有 GPU 時會明確失敗，不會把整套 GPU 測試靜默當成成功。`npm run test:all` 會依序執行上述檢查。

## 診斷記帳

燃料反應以 `rawStraw`、`char`、`volatileGas`、`smoke` 與 reaction ledger 記帳。`exhaustGas` 是域內的可傳輸濃度，不會再和累積反應量重複相加；CPU 與 GPU 的氣體傳輸都會做 mass correction，邊界 fresh-air replacement 與 outflow 會先扣除氣體，再累計排出量。這些數值仍是教學模型的相對量，不是實際質量單位。

## 開發順序

1. Physics v3 CPU fuel model
2. 接回舊版二維 CPU airflow/scalar solver
3. Physics v3 scenario oracle
4. Vite + TypeScript + VGPU
5. airflow GPU migration
6. fuel transformation GPU migration
7. secondary combustion / ash / tracer / rendering

## VGPU 參考

- https://github.com/vercel-labs/vgpu
- https://vgpu.sh/
- https://vgpu.sh/agents.md
- https://vgpu.sh/llms.txt

## 本機設計導師（AI 功能 P1）

模擬器右上角的「🧭 設計導師」會讀取目前爐型與觀察數據，給「這一輪先做」與「接著想一想」，並在畫布上用玫紅框標出相關磚格、在右欄框出相關指標。導師只指出位置，不會替學生放磚或點火。

目前只有「本機提示」模式（規則產生，不呼叫 AI、不需金鑰）。導師需要本機服務，GitHub Pages 線上版不提供：

```bash
npm run tutor:build   # 以 base=/ 建置到 dist-tutor/
npm run tutor:serve   # http://127.0.0.1:8620/
```

Windows 可直接雙擊 `start-tutor.cmd`。服務只監聽本機 `127.0.0.1`。規劃與後續階段（NMKING 真實模型、教師工作台）見 [AI 功能計畫書](docs/AI_TUTOR_PLAN.md)。

## 教育用途

本專案用於比較模型中的相對現象，不用於真實 PM2.5、CO、biochar yield、工程級燃燒效率或安全設計認證。
