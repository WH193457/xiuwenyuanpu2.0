# 侗族纹样数据字典

## 数据源

- 人工维护：`03_标注数据/侗族80张纹样标注成果.xlsx`。
- 网站母纹数据：`03_标注数据/patterns.json`。
- 网站纹样元数据：`03_标注数据/elements.json`。
- 母纹图片：`01_编号图像/{pattern_id}.png`。
- 纹样元图片：`02_纹样元/{element_id}.png`。

Excel含“纹样标注”“纹样元”“资料来源”“词表说明”四张工作表。Excel适合人工校核，JSON是系统读取格式；更新时应保持两者一致。

## Pattern字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | 字符串 | 唯一母纹编号，如`DX001` |
| `image` | 字符串 | 相对`_标注成果`的编号图片路径 |
| `original_file` | 字符串 | 对应原始资料文件名 |
| `name` | 字符串 | 纹样名称，未完全考证时保留“暂定” |
| `category` | 字符串 | 六类主题之一 |
| `main_elements` | 字符串数组 | 主体视觉元素 |
| `secondary_elements` | 字符串数组 | 辅助视觉元素 |
| `composition` | 字符串 | 构图分类 |
| `symmetry_repeat` | 字符串 | 对称与重复关系 |
| `colors` | 字符串数组 | 主要颜色描述 |
| `visual_description` | 字符串 | 可观察的视觉描述 |
| `meaning` | 字符串 | 寓意及证据等级表达 |
| `source_ids` | 字符串数组 | 资料来源关联编号 |
| `element_ids` | 字符串数组 | 关联纹样元编号 |
| `generation_keywords` | 字符串数组 | 创生检索与参数关键词 |

当前分类统计：动物与神兽23件、复合纹样／待定17件、自然天象15件、几何与边饰13件、人物与生活场景8件、植物花卉4件。

## PatternElement字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | 字符串 | 唯一纹样元编号，如`DXE001` |
| `pattern_id` | 字符串 | 来源母纹编号 |
| `image` | 字符串 | 纹样元PNG相对路径 |
| `name` | 字符串 | 纹样元名称 |
| `type` | 字符串 | 主体元等类型 |
| `position` | 字符串 | 在母纹中的位置 |
| `use` | 字符串 | 建议用途 |
| `crop_box` | 四整数数组 | 原图裁切框`[x0,y0,x1,y1]` |

## 数据约束

- ID不重复，大小写保持一致。
- 每个图片路径必须存在。
- 每个`element_ids`值必须存在于`elements.json`。
- 每个纹样元的`pattern_id`必须存在于`patterns.json`。
- `meaning`中的证据说明不得擅自删除或提升确定性。
- 修改后运行`scripts/verify.ps1`。
