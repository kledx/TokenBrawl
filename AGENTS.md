# AGENTS.md

此文件为 AI Coding Agent 在本工作区工作时提供指导。

---

## 工作语言与风格

- 简洁直接
- 代码注释清晰
- （Agent 首次启动时会根据用户偏好调整此段）

---

## Boot Sequence

Agent 启动后：

1. **用户指定 Program**（如 "继续 P-2026-001" 或 "新 Program: xxx"）
2. **读取** `orchestrator/ALWAYS/BOOT.md`
3. **按指示加载**相关文件
4. **输出**当前状态和下一步

如果用户未指定 Program，扫描 `orchestrator/PROGRAMS/` 展示任务列表，询问要做什么。

---

## 目录结构

```
your-project/
├── AGENTS.md                      # 本文件
├── orchestrator/
│   ├── ALWAYS/                    # 核心配置（每次必读）
│   │   ├── BOOT.md                # 启动加载顺序
│   │   ├── CORE.md                # 工作协议
│   │   ├── DEV-FLOW.md            # 开发流程规范
│   │   ├── SUB-AGENT.md           # Sub-Agent 规范（按需使用）
│   │   └── RESOURCE-MAP.yml           # 资源索引
│   │
│   └── PROGRAMS/                  # 开发任务
│       └── P-YYYY-NNN-name/       # 每个 Program 一个目录
│           ├── PROGRAM.md         # 任务定义
│           ├── STATUS.yml         # 状态跟踪
│           ├── SCOPE.yml          # 写入范围
│           └── workspace/         # 工作文档
│
└── repos/                         # 代码仓库（可选，多仓库时使用）
```

---

## 快速命令

- "继续 P-2026-001" — 加载并继续该 Program
- "新 Program: xxx" — 创建新的开发任务，初始化workplace
- "委托: xxx" — 使用 Sub-Agent 执行任务
- "保存/更新进度"：把当前开发任务的进度，完成的工作,以及todo写成md保存到当前PROGRAMS的/workplace中，并Program 状态
---

## 状态来源

- **Programs 列表**: 扫描 `orchestrator/PROGRAMS/` 目录
- **Program 状态**: 读取各 Program 下的 `STATUS.yml`
- **仓库信息**: 读取 `orchestrator/ALWAYS/RESOURCE-MAP.yml`
- **保存进度**：读取各 Program 下的 `STATUS.yml`

不要在此文件维护状态副本，直接从源文件读取。

---

## 架构原则

1. **禁止过度设计** — 不引入不必要的抽象层（如外部 manifest、额外配置文件）。能用链上已有数据解决的，不造新管道。
2. **单一数据源** — 同一份数据只存一处。杜绝链上 persona JSON 和链下 manifest JSON 重复声明同一字段的情况。
3. **合理默认值** — 新功能的默认行为应覆盖最常见场景，不给用户增加配置负担。
4. **不维护旧模式** — 新增功能和优化不引入已废弃的旧版本模式（如经典租赁、旧版 manifest 依赖等），直接基于当前最新架构开发。
5. **KISS** — 优先选择最简单的实现方案。
