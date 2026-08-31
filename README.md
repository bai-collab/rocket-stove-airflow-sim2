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
- VGPU backend 介面骨架
- WGSL `pyrolysis` / `char oxidation` 模組骨架

## 執行測試

```bash
npm test
```

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

## 教育用途

本專案用於比較模型中的相對現象，不用於真實 PM2.5、CO、biochar yield、工程級燃燒效率或安全設計認證。
