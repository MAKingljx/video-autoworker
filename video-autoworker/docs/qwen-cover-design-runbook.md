# H1 完整中文封面设计输入

本入口在H1本地Qwen-Image-Edit-2511上生成完整图片，全部文字和特效由模型输出。调用程序只整理设计说明，不渲染字体、不做人工叠字或后期像素修正。运行目录为`/Users/heisenbergs-1/ai-worker/services/qwen-image-edit-2511/`，生成入口为其中的`venv/bin/python aiworker-qwen-cover.py generate`。

生成命令支持互斥的`--design-file`和`--prompt-file`。前者适合当前已验证的冰晶纪实封面规格；后者继续处理普通自由提示词，不要求所有图片填同一种设计格式。两种输入共用同一个模型生成函数。

## 当前已验证的设计格式

设计JSON的schema为`aiworker-qwen-cover-design/v1`，profile为`ice-documentary`。`text`必须包含四组不同的非空文字：`kicker`栏目标签、`title`主标题、`subtitle`副标题和`caption`底部说明；可选`scene`说明本次原帧主体与场景。控制字符、未知字段和未知profile会被拒绝。当前实际设计文件为`/Users/heisenbergs-1/ai-worker/output/covers/2026-10-03/qwen-type-effects-trial/design.json`。

设计规格默认从脚本旁的`cover-design-profiles.json`读取，源码数据位于`ops/image-generation/qwen-image-edit-2511/cover-design-profiles.json`。当前profile明确要求霜晶、冰裂、下垂冰柱、厚暗轮廓、金色颗粒、红笔刷和蓝色说明线，以及人脸定向中性补光；这些是生成目标，不是已经量测得到的像素值。

`ice-documentary`目前只允许一张主体参考。选择没有封面大标题的原始素材帧，不把已有带字成品作为主体或第二张风格图。一次真实双参考试验曾将请求的新文案全部替换成参考旧标题，因此额外参考会在加载模型和新建输出前被拒绝；这不代表通用多图生成不能使用，也不保证一张任意含字图片都不会干扰文字。

## 当前可复用的实测证据

真实验证使用`source-frame-08-09.png`原帧、1280×720、40步、CFG4和seed301；设计文本经统一规格编译。单原帧候选已由H1生成，四组中文正确，冰霜与冰挂和面部照明明显改善，320像素主副标题可读。仍保留细裂纹、实体厚度和部分装饰线不够精确的限制，不宣称任意标题或所有美术细节都能稳定复现。

当前测试输出路径是`/Users/heisenbergs-1/ai-worker/output/covers/2026-10-03/qwen-type-effects-trial/cover-effects-source-only-s301.png`。这是已有结果，用作审看和复盘；不要覆盖或重新提交同一输出。新的生成须使用当前授权范围内的新设计文件和新输出文件名，输出必须位于H1受控`ai-worker/output/covers/`目录。

## 执行与验收

遵守项目生产授权范围，先确认原帧用途、模型READY、设计文字和输出不存在，再调用已有入口。收据包含设计/profile/原帧摘要、编译提示词摘要、目标文字及验收要求；模型状态`GENERATED_PENDING_REVIEW`只代表原生PNG生成完成。

逐项检查四组文字及重复/旧标题、冰冻材质和轮廓、人脸与衣服高光、缩略图可读性。文字失败时拒绝该候选，不能用特效漂亮抵消，也不能人工改字后继续声称全由模型输出。生成收据记录事实，视觉复核另存受控review记录。只有用户明确选用并授权对应生产写入后，才更新作品封面选中指针或发布；不改动视频任务、业务路由和素材学习事实。
