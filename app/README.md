# 绣纹元谱 · 侗族专项交接版

本项目是面向侗绣纹样整理、检索、智能解构与知识驱动创生的本地研究平台。交接版包含完整网站源码、侗族纹样原始资料、80件编号纹样、15个纹样元、Excel与JSON标注数据、SAM3与LoRA接口代码以及项目研究材料。

## 从这里开始

1. 阅读 `HANDOFF.md`，了解完成状态和下一步任务。
2. 对代码进行修改前阅读 `AGENTS.md`。
3. 在 PowerShell 中运行 `scripts\doctor.ps1` 检查环境。
4. 运行 `scripts\setup.ps1` 安装网站依赖并生成Web资源。
5. 双击 `一键启动网站.cmd`，或运行 `scripts\start.ps1`。
6. 运行 `scripts\verify.ps1` 检查数据与生产构建。

未配置SAM3时，首页、纹样图录、详情、语义画布和成果评价仍可运行，析纹台会显示服务连接状态。真实图像生成使用独立的LoRA服务。恢复智能解构功能请阅读 `SAM3_SETUP.md`。

## 目录导航

- `website/`：React 19、TypeScript、Vite 7前端。
- `纹样库/侗族/原始纹样/`：侗族原始图片和原始说明文件。
- `纹样库/侗族/_标注成果/`：编号图像、纹样元、Excel、JSON和总览图。
- `sam3_service.py`：只在本机运行的SAM3图像分割服务。
- `scripts/`：环境检查、初始化、启动、验收和清单脚本。
- `研究材料/`：立项材料、中期报告、TouchDesigner实验及既有工作包。

## 知识驱动创生

2026年11月8日更新的 `/create` 页面以母纹标注建立初始语义画布，支持六维概念编辑、来源追溯、提示词预览、真实LoRA生成和迭代记录。先运行 `scripts/start-lora.ps1`，再启动网站。服务在8001端口监听，首次生成时加载图像模型。

- `website/src/knowledge.ts` 从规范JSON构建80件母纹、206个概念及827条关系，保留7类标注关系与逐母纹证据。默认 `context-walk-v2` 均匀抽取1至6步游走长度，累计每次转移后的节点访问，以 `[6,5,4,3,2,1]/21` 权重精确传播。创作方向、正向意图关键词、画布和待改进条件共同影响推荐。原均匀终点分布 `context-walk-v1` 和32轮、重启概率0.2的方法保留为对照选项。
- 六个维度为主体与纹样元、构图与关系、色彩、文化意向、视觉风格及表现技法。文化说明保留原始证据等级，可手动补充或通过本机模型整理生成描述，再选择启用。资料面板展示规范Excel中的7条来源及原文链接。
- `prompt_plan.py` 统一编排预览与生成提示词。主体与属性按所属关系组合，整组参与CLIP长度预算，优先级决定顺序。每个启用概念都有采用或省略的具体原因。中文概念可交给本机语言模型整理为英文条件。
- “补充描述（中文 / English）”支持中文、英文和混合输入。预览或生成时仅对需要翻译的补充描述调用本机语言模型，保留原文、实际英文译文及模型名称；语义画布内容不被重写。相同原文复用译文，编辑原文后旧译文失效。翻译失败时停止本次操作并提示，不静默省略中文要求。
- 每轮保存三张候选、种子、参数、提示词及语义方案。服务端记录位于 `outputs/lora/<运行编号>/generation.json`，浏览器IndexedDB保存最近12轮及当前草稿，可恢复条件、批注、导出JSON和下载纹样。下一轮沿用所选候选的种子，轮次对照展示图像、概念和参数变化。
- 每条推荐显示可核对的关联路径，加入画布后保留原始标注、来源与当时的推荐方法。提示词预览增加同一作用范围内的构图冲突、文化来源标记与条件省略检查。生成后可分别核对每张候选的条件，将“部分满足／未满足”项提高为下一轮重点，更新相关知识推荐；历史生成条件不会被改写。
- 对实际采用的全局左右对称、明确180°旋转、满铺接缝条件，服务计算对应图像像素相似度并保存原始数值。低变化图像标为不宜判断。指标不衡量主体识别或文化准确性，局部条件因缺少掩膜不自动评分。

该流程借鉴PromptTCP的知识组织、上下文推荐、概念编排和反馈迭代设计。上下文匹配权重是本项目明确配置的规则，未声称复现论文未披露的匹配函数或训练配置。当前实现采用本地标注关系图、确定性提示词编排、本机语言翻译和参考图视觉分析。新增的结构与配色参考通过裁切、蒙版、图生图和本地ControlNet约束扩散过程，属于本项目的进一步实现。文章来源为 [PromptTCP](https://doi.org/10.1016/j.visinf.2026.100328)。

### 本机模型与生成参数

8001服务提供以下接口。

- `POST /api/lora/preview` 验证语义方案并预览提示词，中文补充描述会先调用本机语言模型翻译；编排与词元检查在CPU进行。`parentId`指向画布中的主体概念，支持多层关系，循环及悬空引用会返回明确错误。停用主体会省略其下属属性。
- `POST /api/lora/refine` 接收`semantic_plan`与`brief`，使用Qwen2-1.5B-Instruct逐项翻译，再返回待确认的语义方案。内部短编号映射保留原概念编号、所属关系、来源与证据类别。模型格式错误会显示失败，页面可继续手动编辑。
- `POST /api/lora/compose` 将整张画布、主体关系、优先级和上下文共同输入本机Qwen，返回待采纳的分组描述。采纳后预览与生成使用相同描述，继续执行CLIP预算及逐项采用记录。语义指纹使修改条件后的旧编排自动失效。原始模型输出和失败记录保存在 `outputs/compositions/`。
- `POST /api/lora/analyze-reference` 接收`image_data_url`，通过Qwen2-VL-2B-Instruct提取主体、构图、色彩及可见纹理。支持8MB以内的PNG、JPEG、WebP，总像素最多1600万。视觉观察仍需要人工核对，原始参考图的规范化副本和观察记录保存在`outputs/references/`。

参考图提示版本 `dong-tobest-1` 采用主题、对象、背景、情绪、风格、技法六维结构，并增加侗绣使用的构图和配色字段。主题与情绪作为待核对建议，默认停用。提示及示例由本项目编写，使用已安装模型推理，论文所述领域微调数据和权重尚未获得。

整图编排策略 `full-canvas-conditioned-groups-qwen-v2` 在推理前保留已有英文的单一非主体条件，记录 `origin=preserved`。主体与属性组合、补充描述及待翻译条件记录 `origin=model`，每次模型补全都提供完整画布。采纳面板展示各组处理方式。该策略用于减少本机小模型改写原子条件时引入其他主体或颜色的问题，模型生成的细微语义仍需要核对。
- `POST /api/lora/generate` 接收`semantic_plan`及参数。`lora_scale`范围为0至1，通过实际模型适配器权重生效。请求缺省值为1，现有调用保持原有强度。新版创作页面初始值为0.35。
- `GET /api/lora/health` 返回模型可用状态、`active_task`和`queued_tasks`。图像生成、语言整理与视觉分析共用推理锁。切换到语言或视觉模型前释放图像模型，语言整理结束及视觉子进程退出后释放相应显存。

语言模型使用本机Hugging Face缓存中的Qwen2-1.5B-Instruct快照`ba1cf1846d7df0a0591d6c00649f57e798519da8`。可设置`XIUVEN_LANGUAGE_MODEL`指向包含完整配置、分词器与权重的目录。视觉模型通过`scripts/setup-local-vision.ps1`安装到`.model-cache/Qwen2-VL-2B-Instruct`，独立运行组件位于`.model-runtime/vision`。安装脚本固定模型版本`895c3a49bc3fa70a340399125c650a463535e71c`及Transformers 4.45.2、Tokenizers 0.20.3。推理只读取本机模型文件。

0.35默认强度根据2026年11月8日的两种子探索选择。相同蝴蝶描述在第一个种子下，0.35保留了主体和针线质感，1.0生成了几何满铺。第二个种子下三档均偏离主体。完整六图、参数和逐图观察位于`outputs/verification/lora-strength-comparison.png`及同名JSON。该样本量需要继续扩大，后续应覆盖更多主体、母纹和随机种子。

### 2026年11月9日复现验证

本轮已增加TOBEST结构化观察、累计访问游走、整图上下文编排与真实配对实验。实现校验通过85项后端测试、生产构建及浏览器正常流程检查。

实验预定8类纹样、4种方法、每类3个固定种子，实际生成93／96张图。鱼纹的完整流程组因语言模型丢失白色条件被拦截，其余31组图像生成全部成功。完整流程相对直接提示在7个完整配对任务上的CLIP差值为−0.007604，95%区间为[−0.017029，0.001824]，当前结果未支持整体图文一致性提升。全部原图、失败记录、修订前后方案及统计均已保存，真人评价待采集。

完整说明见 [复现与效果验证记录](outputs/reproduction-2026-11-09-v2/README.md)，图像及统计见 [实验总览](outputs/reproduction-2026-11-09-v2/index.html)，匿名评分入口见 [盲评页面](outputs/reproduction-2026-11-09-v2/blind-review/index.html)。论文同模型、同图谱的原版数值复现仍需要作者未提供给本项目的微调资源和完整实验配置。

### 主体与构图优先模式（2026年11月9日）

创生工坊新增“生成策略”选择。新建草稿默认使用“主体与构图优先”，读取旧草稿或历史记录时按其保存的策略恢复。服务端 `generation_profile` 接受 `subject-fidelity` 与 `standard`，省略字段使用 `standard`。当前编排器版本为 `dong-semantic-plan-6`，LoRA强度仍由用户设置，新建草稿为0.35。

主体优先模式把主体及所属属性作为完整组放在前面，再编排构图与其他条件。主体因缺英文或预算不足而无法完整采用时，预览会提示精简或补充条件，生成在推理前停止。该模式使用画布自身的主体与风格描述，并依据实际采用的条件抑制装饰外框、绣绷、地毯式满铺等偏移。明确要求的边饰、画框、重复与局部竖条纹有对应保护规则。负向条件逐词组检查CLIP预算，决策及省略项保存在 `generation_policy` 中。预览、实际生成、草稿、历史和JSON导出使用同一策略记录。

本轮固定8类任务、原3个种子新增24张图，完整对照旧直接描述24张和旧知识画布24张。蝴蝶、龙及部分鸟、人形样例的主体辨识改善；八角星、鱼形和连续边带仍不稳定，部分结果保留外框、裁切或伪文字。相对旧知识画布的平均CLIP余弦差为+0.006453，95%任务级bootstrap区间为[−0.013536，+0.027082]，整体分数提升仍有不确定性。八个固定任务文本间的检索首位比例由11/24变为21/24，该数值衡量自动文本检索。真人与专家评价仍待采集。完整72张图和统计见 [主体与构图改进验证](outputs/subject-fidelity-validation-2026-11-09/index.html)。

另保存32张强度与时机探索、18张触发词／负向消融、24张分阶段条件探索和32张布局描述探索。分阶段切换与额外布局描述在部分任务上改善、部分任务上退化，该阶段选择经过完整24图对照的主体优先策略。其文本空间条件对精确点数、位置、连臂关系和外框消除仍有局限。

验证通过105项后端测试、80件母纹默认画布的真实预览、生产构建、知识与历史回归。真实浏览器测试覆盖整图编排、中英混合描述、实际生成、策略切换、刷新、历史、导出、6个主路由与手机布局。新增检查入口为 `website/scripts/test-generation-profile.mjs`、`website/scripts/test-generation-plan-coverage.mjs` 与 `website/scripts/test-subject-fidelity-validation.mjs`。

### 结构、配色与针线材质参考（2026年11月9日）

创生工坊的“结构与配色参考”支持当前母纹、纹样元和独立上传图片。启用后设置裁切、主体提取方式、前景与背景颜色、居中或横向边带布局，再检查准备图、轮廓图与蒙版，点击“采用此结构与配色”。更换主体或设置后需重新准备并采用。新草稿的结构参考默认关闭，启用后的默认重绘强度为0.55、轮廓强度0.8，图像为512×512。默认针线材质引导在扩散前加入确定性细线和织物纹理，生成后保存模型原始PNG。

`POST /api/lora/prepare-reference`在CPU准备参考，规范来源通过编号映射读取，上传上限8MB和1600万像素。`reference_conditioning.py`保存原图副本、蒙版、配色图、控制图及逐文件SHA256。版本`masked-reference-canny-3`以有效透明度计算布局与轮廓，避免微透明边缘形成载体外圈。可选`texture_mode=stitched`使用`embroidery_material.py`的`embroidery-input-material-1`，默认API值`source`沿用参考纹理。历史v1/v2准备记录继续按其原像素读取。

预览与生成通过`reference_conditioning`传递已确认的编号、摘要、方法和强度。图生图与ControlNet图生图复用SD1.5与侗绣LoRA，受同一推理锁管理。记录包含实际去噪步数、参考版本及参数，并为每轮保存输入图、轮廓图和蒙版。30个名义采样步在0.55重绘强度下实际执行16步。草稿、历史与JSON导出保存确认时的来源、配置和准备图。

本机ControlNet使用官方`lllyasviel/control_v11p_sd15_canny`固定版本`115a470d547982438f70198e353a921996e2e819`、fp16安全张量，权重约723MB。安装入口为`scripts/setup-controlnet.py`，缓存位于`.model-cache/control_v11p_sd15_canny`，下载摘要与许可信息保存在该目录的`download-verification.json`。推理依赖现有LoRA环境中的Diffusers、PyTorch、Pillow、NumPy与OpenCV，验证环境的Diffusers版本为0.30.3。模型使用CreativeML OpenRAIL-M许可。[官方模型说明](https://huggingface.co/lllyasviel/control_v11p_sd15_canny)

参考轮廓需要与创作主体匹配，裁切和颜色分配由用户核对。程序针线材质包含固定方向的细线，复杂针法与真实手工刺绣的方向变化仍需进一步改进。

正式对照使用4件规范纹样形成6个任务，每任务3个新种子，比较主体优先文本T、针线参考图生图I、平面参考加轮廓F、针线参考加轮廓R，共72张全部生成成功。四组采用相同实际正负提示词、LoRA0.35、CFG7.2及512尺寸，配置采样步数均为30，参考三组实际执行16个去噪步。I/R共享同一针线参考，F/R共享原图、蒙版和控制图。试验前冻结代码、模型摘要、准备图与参数，manifest SHA256为`b939c3a4250c4e0861a59e282f70ebfd137d2baa05336897ef0039cc8ba92b37`。

轮廓控制的R−I比较中，参考主体区域IoU由0.857436提高到0.948361，主体区域CIE76色差由8.961150降至4.672816。材质引导的R−F比较中，IoU平均下降0.003404、背景色差增加0.824156，逐图目检显示红蝶、白星和粉色团花的细线更明显，黑色细纹改善有限。完整方案的CLIP均值为0.305652，文本组为0.314666。边缘指标只是外侧空白区域的低频边缘代理，少量杂色、布面印迹及较小的候选变化仍可见。数据来自开发使用过的4件纹样，任务级区间仅描述这组任务，真人评分为0。全部原图、参考输入、细节图及统计见[72张结构与材质对照](outputs/reference-control-validation-2026-11-09/index.html)。另保留本轮64张参数与材质探索图。

当前实现通过149项后端测试、生产构建、数据基线与前端新旧状态回归。真实网页流程核验了6个主路由、390px布局、准备与采用后立即刷新、三张候选、历史恢复、导出及下载PNG一致性。实际ControlNet生成后切换Qwen处理中文补充描述，再重新加载ControlNet生成两张图也已通过，记录位于`outputs/reference-model-switch-2026-11-09/verification.json`。

### 既有流程回归命令

在 `website` 目录运行 `node scripts/test-knowledge.mjs`、`node scripts/test-contextual-knowledge.mjs`、`node scripts/test-creation-history.mjs` 和 `npm.cmd run build`。启动网站及LoRA服务后，`node scripts/test-co-creation.mjs` 与 `node scripts/test-contextual-workflow.mjs` 会执行真实GPU生成和浏览器操作验证。后端回归命令为 `python -B -m unittest discover -s tests`，涵盖语义编排、来源保留、模型编号校验、强度恢复、推理互斥、参考图、上下文、条件检查和图像结构指标。

推荐对照记录保存于 `website/test-results/contextual-recommendation-comparison.json`，包含4件母纹、4种目标、旧方法排名、实测运行时间和数据摘要。浏览器实机核验保存于 `website/test-results/contextual-workflow-verification.json`。这些记录验证实现行为，不等同于图像质量提升实验或真实用户研究。

## 数据基线

- 侗族交接数据：183个文件，约243.31 MB。
- 编号纹样：80件，编号为`DX001`至`DX080`。
- 纹样元：15个，编号使用`DXE`前缀。
- 数据源：`纹样库/侗族/_标注成果/03_标注数据/`。

## 常用命令

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

项目按Windows与NVIDIA CUDA环境设计。Node.js要求22.12或更高版本。依赖由`package-lock.json`锁定，不应交接`node_modules`、`dist`或生成后的`public`资源。
