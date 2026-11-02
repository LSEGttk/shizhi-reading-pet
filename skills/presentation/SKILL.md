---
name: presentation
description: 根据困惑选择文字、公式、关系图、交互实验或有来源的图片。
---
选择最省认知负担的讲解形式。普通问题用短文；对比用 Markdown 表格；推导用 $...$ 或独占行 $$...$$；因果和结构用图；只有调参数确实能帮助理解时才放交互。不要为了展示功能堆砌组件。除明确要求多种形式，每次最多一个图示或演示。
支持标准 Markdown 标题、列表、表格、代码。不要输出 HTML、JavaScript、事件属性或远程脚本。
可以用 ```mermaid 代码围栏画流程/关系图（无 click、style、配置、外链），或 ```svg 围栏输出静态 SVG（禁止外部资源）。图中文字简短，侧栏优先纵向。
交互组件用 ```reading-pet 围栏内一个严格 JSON 对象，所有字段和枚举使用下面的定义：
1. 阶段：{"type":"steps","title":"学习过程","items":[{"title":"看例子","body":"先看一个具体变化"},{"title":"迁移","body":"换个输入再验证"}]}
2. 分组关系图：{"type":"flow","title":"两个循环","direction":"TD","nodes":[{"id":"A","label":"阅读","group":"理解"},{"id":"B","label":"笔记","group":"积累"}],"edges":[{"from":"A","to":"B","label":"整理"}]}
3. 矩阵实验（最多 4×4）：{"type":"matrix","title":"每行算一个输出","matrix":[[1,2],[3,4]],"vector":[1,2]}。矩阵乘列向量，用户可点行、拖输入观察结果。
4. 字符级 BPE 教学实验：{"type":"bpe","title":"高频片段变短","text":"low lowest","corpus":[{"text":"low","count":5},{"text":"lowest","count":3}],"merges":5}。是真实本地合并计算，但并非真实模型分词器；不要声称字符级示例能覆盖任意字符。
5. 自定义参数计算器：{"type":"calculator","title":"参数量随词表增长","inputs":[{"key":"v","label":"词表大小","min":1000,"max":100000,"step":1000,"value":32000,"unit":"项"},{"key":"d","label":"向量维度","min":64,"max":4096,"step":64,"value":512,"unit":"维"}],"outputs":[{"label":"Embedding 参数量","expression":"v*d","unit":"个","digits":0}]}。只支持数字、输入变量、+ - * / ^、括号和 min/max/abs/sqrt/log/exp；最多6输入4输出。解释假设和单位；滑块由插件计算，不能预编造结果。
6. 原文图片：{"type":"image","sourceId":"img-上下文已提供的ID","title":"原文图","alt":"图片如何帮助理解"}，或 Markdown ![说明](article:img-ID)。只能引用上下文真实存在的图片 ID；当前接口只看图片说明，不能声称看到了未提供的像素。外部 HTTPS 图片可用标准 Markdown，必须有真实来源，用户点击才加载；不编造图片地址。
7. 需要新插画时：{"type":"generate-image","title":"用图理解这个过程","prompt":"清楚描述教学目标、场景、构图及中文标注","alt":"这张插画说明什么"}。这是生成入口；用户点击后由独立图片接口生成，不是已生成的图，也不作为事实证据。
每个组件必须有清楚的教学目的。组件前一句告诉用户看什么、调什么；组件后仅在必要时指出观察结果的含义。代码围栏外保留关键结论，渲染失败也应能理解。

observedDemoState 只表示用户观察或修改过的演示参数，可用来解释其眼前结果，不能据此判断用户已理解或掌握，也不把一次操作当成长期偏好。
