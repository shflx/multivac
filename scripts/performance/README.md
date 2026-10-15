# 运行接口性能验证

此目录的脚本独立于普通单元测试，不设置机器耗时门槛，不加载真实 Multivac 数据，不启动应用调度器或 Pi，不派生子进程。基线固定为 `87ab69f3302b91c238ce9e95d45af99fc944d5c6` 的任务查询、完整校验、服务计算及可见进程列表计数路径。状态显示辅助函数沿用契约实现；本次仅收窄该函数输入类型，函数体未改。

## 执行

在已安装项目依赖、支持 Node SQLite 的环境，从仓库根目录运行：

```sh
npm run build -w @multivac/contracts
npm run build -w @multivac/server
node scripts/performance/runs.mjs
```

构建必须对应待测源码；脚本读取 `apps/server/dist`，不能复用旧构建。端口默认 `127.0.0.1:38471`，只用于脚本内客户端访问。受控任务运行时必须声明同一端口。输出写到新建的 `artifacts/runs-performance/sample-*`，不接受已有数据库路径。每次运行分别新建旧版/新版数据库，插入完全相同的事实并核对 SHA-256；两库分别保持旧索引和增加新索引。临时数据库在结束时关闭并清理，保留 JSON 原始样本及 Markdown 汇总；若在初始化导入前失败，不会生成结果。

默认每项暖身5次、测量30次，交替旧版/新版的测量顺序。每个规模均包含历史任务为主、等待任务为主两组数据，固定8个停止未确认的运行及不同的任务标签；包含缺失/归档会话、未开始、准备、停止中、停止意图、恢复及旧可选字段。任务及运行包含固定文本负载，部分运行有任务树快照。100/1000/10000表示任务数和已退出后台进程历史数，另有固定6个混合状态进程。SQLite 固定 WAL、NORMAL、20 MiB 页缓存，数据生成后执行 ANALYZE。

每组数据先核对两实现18个查询的完整结果，含默认/true/false、分页/空页、total/counts/highlights/排序/版本/会话可用性；不一致立即失败。采集真实新查询 SQL 与进程仓储实际发出的 SQL，执行 EXPLAIN QUERY PLAN。报告阶段：

| 字段 | 包含的工作 |
| --- | --- |
| databaseTasks | SQLite prepare/all 与版本查询，含驱动结果物化，不含 JS JSON.parse/契约校验 |
| databaseProcesses | SQLite prepare/all，不含 JS 进程列表解析、校验、排序 |
| repositoryWithDecode | 完整候选读取，加 JSON 解析及对应契约校验 |
| processCountsWithDecode | 实际进程计数路径，旧版含完整可见列表、解析、校验及排序 |
| serviceComputeOnly | 用已读取事实计算显示、排序、全范围统计、摘要及分页，不含仓储读取 |
| serviceIncludingReads | 服务完整路径，含两类仓储读取 |
| http | 实际 task-routes 的 /api/runs 路由、服务、JSON 编码、回环传输及客户端 JSON 解析 |

各阶段独立计时，不用两个阶段的中位数相减推导“净开销”。JSON保存原始样本、中位数、p95、p99、最大值、数据库版本、CPU、Node、系统版本、locale及核心源码/构建产物/脚本的SHA-256；Markdown汇总中位数、p95和最大值。环境中其他程序的负载仍需保持稳定，不能把交替测量视为系统隔离。

## 轮询与其他接口

脚本使用实际任务 HTTP 路由，分别测空闲、单窗口、四窗口同时刷新。默认间隔5000ms，与 `runs-provider.tsx` 的低频核对一致，每组3轮。轻量接口 `/api/task-groups` 和 `/api/tasks?ids=task:000000&limit=1` 每100ms读取，分别记录发送后耗时、计划时间至完成耗时、定时器调度迟到。计划时间固定，避免客户端与服务处于同一事件循环时隐藏请求发出前的阻塞。

此负载只模拟 runs 请求，不包含进程列表的独立轮询、SSE、真实 Pi 执行或浏览器渲染。同进程客户端不能替代外部客户端复核。结果可核对 runs 的同步工作对两条轻量路由的影响，但不能据此推断整个应用或此前长延迟的根因。

可设置 `RUNS_PERF_SAMPLES`（10..1000）、`RUNS_PERF_ROUNDS`（2..20）、`RUNS_PERF_INTERVAL_MS`（100..10000）及 `RUNS_PERF_PORT`（1024..65535）。所有参数进入报告；改变参数后只比较同一次运行生成的旧/新结果。缩短间隔是额外压力场景，不代表真实页面频率。

## 正确性回归

最小回归范围为 `process-counts.test.ts`、`runs-query.test.ts`、`runs.test.ts` 及 `managed-processes.test.ts` 的迁移测试。另检查服务与契约类型。完整运行/进程生命周期测试含真实隔离进程，不属于本次性能脚本。

```sh
node --import tsx --test apps/server/tests/process-counts.test.ts apps/server/tests/runs-query.test.ts apps/server/tests/runs.test.ts
node --import tsx --test --test-name-pattern='已有版本 35' apps/server/tests/managed-processes.test.ts
npm run check -w @multivac/server
```

上述命令用于常规开发验证，须遵循执行环境对子进程和依赖的限制。性能结论只采用脚本实际生成且状态为 completed 的结果；执行失败与未执行的阶段应单独记录。
