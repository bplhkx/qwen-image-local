<div align="center">

<img src="assets/banner.jpg" alt="qwen-image-local —— 在 NVIDIA GPU 上本地运行 Qwen-Image-2.1 的文生图与照片编辑；这张横幅由模型在 RTX 3060 上先生成、再编辑而成。" width="100%"/>

**语言：** 简体中文 · [English](README.md)

**写一句提示词，或最多拖入 10 张照片：Qwen-Image-2.1 在你 8 GB 显存的显卡上约 35 秒出图，全程不上传，内容一步都不离开这台电脑。**

[![状态](https://img.shields.io/badge/status-beta-d29922?style=flat-square)](CHANGELOG.md)
[![Windows](https://img.shields.io/badge/windows-10%20%7C%2011-0078D4?style=flat-square&logo=windows&logoColor=white)](https://github.com/Mats2208/qwen-image-local/releases)
[![Stars](https://img.shields.io/github/stars/Mats2208/qwen-image-local?style=flat-square&logo=github&color=e3b341)](https://github.com/Mats2208/qwen-image-local/stargazers)
[![模型](https://img.shields.io/badge/model-Qwen--Image--2.1-615CED?style=flat-square)](https://huggingface.co/Qwen/Qwen-Image-2.1)
[![基准测试](https://img.shields.io/badge/benchmark-vs%20gpt--image--2-4051B5?style=flat-square)](https://mats2208.github.io/qwen-image-local/)
[![许可证](https://img.shields.io/github/license/Mats2208/qwen-image-local?style=flat-square&color=green)](LICENSE)

<br/>

<table>
<tr>
<td align="center"><strong>8 GB</strong><br/><sub>显存，每个阶段完整跑在 GPU 上</sub></td>
<td align="center"><strong>35 秒</strong><br/><sub>一张 1024² 图片，RTX 3060</sub></td>
<td align="center"><strong>10</strong><br/><sub>每次编辑可参考的照片数</sub></td>
<td align="center"><strong>20</strong><br/><sub>对比 gpt-image-2 的测试，全部公开</sub></td>
<td align="center"><strong>0</strong><br/><sub>零上传：提示词和照片都留在本机</sub></td>
</tr>
</table>

**📊 基准测试：** [mats2208.github.io/qwen-image-local](https://mats2208.github.io/qwen-image-local/) &nbsp;•&nbsp; **🛠️ 自己构建：** [一条命令](#安装) &nbsp;•&nbsp; **⭐ [给个 Star](https://github.com/Mats2208/qwen-image-local/stargazers)**：如果你的显卡能跑动，star 一下，别的小显存用户才找得到它。

</div>

---

Qwen-Image-2.1 发布于 2026 年 9 月 20 日。它是第一个既**好用**又**小巧**的开源权重图像模型：生成器只有 7B，而大多数优秀的开源模型都在 10–20B。这个仓库就是给没有 24 GB 显卡的人补上的那块拼图：一键桌面应用加命令行工具，帮你装好、塞进显存，然后不打扰你。

<sub>非官方项目，与阿里巴巴或 Qwen 团队无关。模型权重不可商用，详见[许可证](#许可证)。</sub>

## 效果展示

<p align="center"><img src="assets/screen-edit.png" alt="Qwen Image Local 把一张生成的书店图片改成雪夜；可见参考图、指令、快捷编辑按钮和历史记录条" width="100%"/></p>
<p align="center"><sub><b>照片模式。</b>历史条右侧那张书店图本来是从文字生成的；点“编辑这张图”把它作为参考图送回，再点一下<b>雪夜</b>，53 秒后雪和冷光就到位了，而楼梯、灯和猫都还在原位。</sub></p>

<table>
<tr>
<td width="50%">
<p align="center"><img src="assets/screen-setup.png" alt="首次运行的安装界面，显示检测到的 RTX 3060、推荐的显存档位和待安装文件列表" width="100%"/></p>
<p align="center"><sub>首次运行。它会读取你的 GPU、驱动和剩余磁盘，推荐一个档位，下载前把每个文件都列清楚。已经有权重了？指向那个文件夹就能复用。</sub></p>
</td>
<td width="50%">
<p align="center"><img src="assets/screen-working.png" alt="生成过程中的界面，显示第 4/20 步、每步 1.8 秒、剩余 29 秒，显存占用 11.3/12 GB" width="100%"/></p>
<p align="center"><sub>生成中。步数、每步耗时和剩余时间都来自引擎本身；右上角的进度条是你的真实显存（<b>11.3 / 12 GB</b>）。</sub></p>
</td>
</tr>
</table>

<p align="center"><img src="assets/banner-edit-before-after.jpg" alt="修改前后对比：模型清掉了自己横幅里乱码的小字，其余部分保持不变" width="720"/></p>
<p align="center"><sub>顶部那张横幅也是模型做的。标题渲染得完美，但它在图片下面自己编了些乱码小字（左）；在照片模式里再来一句 <i>“去掉底部所有小字……”</i>，就干净了（右）。</sub></p>

## 它能做什么

| | 功能 | 说明 |
|---|---|---|
| **创作** | 文生图 | 草稿 1024² · 标准 1.6 MP · 最高原生 2K，七种画幅，可锁定种子 |
| **透明** | 原生 RGBA | 真实 alpha 通道由模型直接产出，不靠抠图去背景那套 |
| **编辑** | 1–10 张参考图 | 重打光、改风格、移除物体或人物、重写招牌、合成主体；第一张图是画布 |
| **随机惊喜** | 创意生成器 | 风格 × 主体 × 地点 × 光线，或一个精选创意；可填主题 |
| **安装** | 一条命令构建 + 一次性安装 | 锁定版本的 ComfyUI、Python 3.12、PyTorch CUDA 13、权重支持断点续传与 SHA-256 校验 |
| **命令行** | `qil` | `doctor` · `setup` · `generate` · `edit` · `surprise` · `bench` · `config` |
| **隐私** | 全程本地 | 提示词和照片只会发往 `127.0.0.1` 上的引擎。每张图都会附带一个记录提示词、种子和参数的 `.json` |

## 实打实的基准测试：哪里赢，哪里输

20 条提示词，**每个模型只跑一次，不挑好看的**。Qwen-Image-2.1 在 RTX 3060 12 GB 上（int8，40 步，原生 2K），对比云端的 gpt-image-2。编辑类测试用的是 Wikimedia Commons 的真实照片。

| 分类 | Qwen 胜 | 平 | gpt-image-2 胜 |
|---|---:|---:|---:|
| 摄影（6） | 0 | 1 | 5 |
| 创意（6） | 0 | 0 | 6 |
| **照片编辑（8）** | **1** | **7** | **0** |
| **合计** | **1** | **8** | **11** |

**编辑照片时，它和 gpt-image-2 打平**，而且免费、私密、不限次数。**文生图则不如它**：长提示词遵循得没那么准，世界知识也少一些（让它画马黛茶杯，它两次都画成了中国葫芦）。每张图、每条提示词、每个判定都在[基准测试页面](https://mats2208.github.io/qwen-image-local/)上。

<table>
<tr>
<td width="33%"><p align="center"><img src="docs/img/bench/in_vidriera.webp" alt="Solar Roast Coffee 招牌的输入照片" width="100%"/></p><p align="center"><sub>输入：一家真实的店面</sub></p></td>
<td width="33%"><p align="center"><img src="docs/img/bench/E3_cartel_texto_qwen.webp" alt="Qwen-Image-2.1 把招牌改成 LA PORTEÑA CAFÉ" width="100%"/></p><p align="center"><sub><b>Qwen，本地：</b>“LA PORTEÑA / CAFÉ”，Ñ 和重音都在，金色衬线一致，logo 没动</sub></p></td>
<td width="33%"><p align="center"><img src="docs/img/bench/E3_cartel_texto_gpt.webp" alt="gpt-image-2 改写同一块招牌" width="100%"/></p><p align="center"><sub><b>gpt-image-2：</b>同样干净。平局。</sub></p></td>
</tr>
<tr>
<td width="33%"><p align="center"><img src="docs/img/bench/in_bici.webp" alt="靠墙的绿色自行车输入照片" width="100%"/></p><p align="center"><sub>输入：“去掉背景”</sub></p></td>
<td width="33%"><p align="center"><img src="docs/img/bench/E7_bici_recorte_qwen.webp" alt="Qwen 按原尺寸抠出自行车并透明化背景" width="100%"/></p><p align="center"><sub><b>Qwen 胜：</b>就是那辆自行车，位置和大小不变，可直接拿去合成</sub></p></td>
<td width="33%"><p align="center"><img src="docs/img/bench/E7_bici_recorte_gpt.webp" alt="gpt-image-2 把自行车画得更大并透明化背景" width="100%"/></p><p align="center"><sub>gpt-image-2 把它画大了，后货架也改了</sub></p></td>
</tr>
<tr>
<td width="33%"><p align="center"><sub>文生图：<br/><i>“信息图‘Cómo preparar mate’（如何冲马黛茶），6 个编号步骤……”</i></sub></p></td>
<td width="33%"><p align="center"><img src="docs/img/bench/C3_infografia_mate_qwen.webp" alt="Qwen 的信息图，小字说明拼写有误" width="100%"/></p><p align="center"><sub><b>Qwen 输：</b>大标题完美，小字说明拼错（“Inclinar <b>enj</b> mate”），杯子画成了普通杯而不是马黛茶杯</sub></p></td>
<td width="33%"><p align="center"><img src="docs/img/bench/C3_infografia_mate_gpt.webp" alt="gpt-image-2 的信息图，说明正确且有马黛茶图标" width="100%"/></p><p align="center"><sub><b>gpt-image-2 胜：</b>每条说明都对，画的是真正的马黛茶壶</sub></p></td>
</tr>
</table>

## 怎么塞进有限显存

三个模型加起来装不下：文本编码器 8.9 GB + 图像模型 6.9 GB + VAE 0.6 GB = 16.4 GB。所以它们**一次只跑一个阶段，每个阶段完整载入显存**，其余的在系统内存里等着。没有任何东西被拆到 CPU 和 GPU 之间——正是这一点让低显存方案变得很慢。引擎日志可以印证（三个阶段都是 `loaded completely … full load: True`），速度也能印证：1024² 每步 1.35 秒，在 RTX 3060 上是算力受限而非显存受限。

有两个选择的分量超过其他一切：

- **int8 “convrot” 权重，而不是 GGUF。** Ampere 及更新的显卡有 int8 张量核心，ComfyUI 为这种格式自带原生算子，所以比实时反量化 GGUF 更快，且几乎无损。
- **为 CUDA 13 编译的 PyTorch。** 用 CUDA 12.8 的构建时，ComfyUI 会悄悄关掉它优化过的 CUDA 后端。安装器会挑对构建，并检查你的驱动（R580 或更新）。

## 安装

**运行要求：** Windows 10/11 · NVIDIA 显卡，8 GB（紧凑档位）或 12 GB（均衡档位）· 驱动 580+ · 约 25 GB 剩余磁盘 · 32 GB 内存（这是实测配置；16 GB 未测）。

### 方案 A · 自己编译（推荐，约 5 分钟）

在你自己电脑上编译出来的二进制不带“从网上下载”的标记，所以 Windows SmartScreen 不会拦你，而且你清楚自己跑的到底是什么。

**1. 一次性准备依赖。** 粘到任意终端里：

```powershell
winget install Rustlang.Rustup
winget install OpenJS.NodeJS.LTS
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

装完关掉终端再重开，让它加载到新工具。

**2. 克隆并构建。** 按你用的终端选对应的那一块：

<table>
<tr><th>终端</th><th>命令</th></tr>
<tr><td><b>PowerShell 5.1</b><br/><sub>Windows 自带的那个</sub></td><td>

```powershell
git clone https://github.com/Mats2208/qwen-image-local; cd qwen-image-local
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

</td></tr>
<tr><td><b>PowerShell 7</b><br/><sub>pwsh，Windows Terminal 默认</sub></td><td>

```powershell
git clone https://github.com/Mats2208/qwen-image-local; cd qwen-image-local
pwsh -ExecutionPolicy Bypass -File ./build.ps1
```

</td></tr>
<tr><td><b>CMD</b><br/><sub>命令提示符</sub></td><td>

```bat
git clone https://github.com/Mats2208/qwen-image-local && cd qwen-image-local
.\build.cmd
```

</td></tr>
<tr><td><b>Git Bash · Warp</b><br/><sub>Windows 上任意 bash</sub></td><td>

```bash
git clone https://github.com/Mats2208/qwen-image-local && cd qwen-image-local
./build.sh
```

</td></tr>
<tr><td><b>不想用终端</b></td><td>

下载[源码 zip](https://github.com/Mats2208/qwen-image-local/archive/refs/heads/main.zip)，解压后**双击 `build.cmd`**。

</td></tr>
</table>

这五种走的都是同一个 `build.ps1`：先检查依赖（缺什么会告诉你确切命令），然后在 `out\` 里留下 `qwen-image-local.exe` 和 `qil.exe`。加 `-Installer` 还能一并构建安装用的 `.exe`。已在 PowerShell 5.1、PowerShell 7.6、CMD 和 Git Bash 上测过。

**3. 运行** `out\qwen-image-local.exe`。首次启动会安装引擎并一次性下载约 **19.5 GB**：引擎、Python、PyTorch，以及从 [Hugging Face](https://huggingface.co/Comfy-Org/Qwen-Image-2.1) 拉的权重。下载中断可续传，并按 SHA-256 校验。

### 方案 B · 预构建安装包

从 [Releases](https://github.com/Mats2208/qwen-image-local/releases/latest) 下载 `Qwen.Image.Local_x.y.z_x64-setup.exe` 运行即可；它只装到你这个用户下，不需要管理员权限。由于没有代码签名（证书要花钱），首次运行时 SmartScreen 会警告：**更多信息 → 仍要运行**。

两种方式，所有东西都在 `%LOCALAPPDATA%\qwen-image-local`（模型可以放到别的盘），卸载就是删掉这个文件夹。

## 快速上手（命令行）

`qil.exe` 出自同一次构建（或 release 压缩包），用的是和应用相同的安装。

```text
> qil doctor
GPU        RTX 3060 · 12.0 GB VRAM · driver 610.88 (ok)
profile    balanced (12 GB+ (int8 encoder))
  [x] uv 0.12.18 (Python manager)
  [x] ComfyUI engine
  [x] Python 3.12
  [x] PyTorch (CUDA 13) + engine packages
  [x] qwen_image_2.1_int8_convrot.safetensors (6.76 GB)
  [x] qwen3vl_8b_int8_convrot.safetensors (8.71 GB)
  [x] qwen_image_2.1_vae_bf16.safetensors (644 MB)
Ready. Try: qil generate "a red fox asleep in the snow" --preset draft
```

```bash
qil setup                                             # 安装；档位按你的显存自动选
qil generate "一只在雪里睡着的红狐" --preset draft
qil generate "马黛茶壶贴纸" --transparent --aspect 1:1
qil edit "把场景改成下雪的冬夜" -i street.jpg --preset standard
qil edit "把 <image2> 里的狗放到 <image1> 的自行车旁" -i bike.jpg -i dog.jpg
qil surprise --theme capybaras
qil bench --suite bench/suite.json --preset max       # 复现公开的基准测试
```

加 `--keep-engine` 可以让引擎在多次调用之间保持运行，这样每次都省掉启动时间。

## 显存档位

| 档位 | 文本编码器 | 峰值显存（含桌面） | 1024²，20 步 | 状态 |
|---|---|---:|---:|---|
| **均衡** | int8，8.9 GB | 11.4 GB | 32 秒 | 已在 RTX 3060 12 GB 实测 |
| **紧凑** | w4a8，6.3 GB | 7.2 GB | 33 秒 | 已在 RTX 5060 Laptop 8 GB 实测 |

紧凑档位在速度不变的前提下把峰值显存降了约 2.5 GB，并已在真实的 8 GB 卡上验证通过（RTX 5060 Laptop，含桌面峰值 7.2 GB）。如果你手上是 10 或 16 GB 的卡，在 [bench/tiers](bench/tiers) 跑一次 `qil bench` 依然是对这个仓库很有价值的贡献。

## 它（暂时）不做什么

- **仅支持 Windows 上的 NVIDIA。** 如果你用 AMD、Intel、Apple Silicon，或显存不到 8 GB，请用 [nihui/qwenimage-ncnn-vulkan](https://github.com/nihui/qwenimage-ncnn-vulkan)：一个能在任意 Vulkan GPU 上跑的命令行工具，用速度换显存。
- **采样时没有实时预览**；你看到的是最终成品图。
- **没有蒙版和画笔。** 局部编辑靠文字描述；模型本身支持蒙版和标记，只是应用还没暴露出来。
- **没有提示词扩写。** Qwen 官方的改写器是另一个 9B 模型，在 12 GB 上没法和主模型并存。
- **权重仍是 Qwen Research License 期间不可商用。**

## 常见问题

**什么 AI 图像模型能在 RTX 3060 这种 12 GB 显卡上跑？** 用 int8 权重、一次只加载一个阶段的 Qwen-Image-2.1。这个应用帮你把这套配置装好了：一张 1024² 图约 35 秒，原生 2K 约 7 分钟。

**Qwen-Image-2.1 有 gpt-image-2 好吗？** 编辑照片时，按我们的测试是打平（8 次里 7 平 1 胜）。文生图则不如（12 次里 gpt-image-2 赢了 11 次）。

**能用我现有的 ComfyUI 模型文件夹吗？** 能。在安装界面选它，或运行 `qil setup --models-dir <文件夹>`。大小匹配的文件不会重复下载。

## 仓库结构

```
crates/qil-core   安装器、引擎生命周期、生成客户端、GPU 检测（Rust）
crates/qil-cli    qil 命令行
app/              Tauri 2 桌面应用（Rust + 纯 HTML/CSS/JS，英/西/中三语）
bench/            suite.json、带署名的输入照片、结果、判定、站点构建脚本
docs/             GitHub Pages 基准测试站点
```

`build.ps1` / `build.cmd` / `build.sh` 封装了两步构建：`cargo build --release -p qil-cli`，以及在 `app/` 里跑 `npx tauri build`。

## 帮它传开

这个项目的存在，是因为 12 GB 的卡不该只被建议“去买 4090”。如果你的显卡也能跑：

- **⭐ [给仓库点 Star](https://github.com/Mats2208/qwen-image-local/stargazers)。** 这是让 GitHub 和搜索引擎把项目推给下一个小显存用户的最有效一件事。
- **分享它**，去大家会问“我这卡能跑什么”的地方：[r/StableDiffusion](https://www.reddit.com/r/StableDiffusion/)、[r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/)、[X / Twitter](https://twitter.com/intent/tweet?text=Qwen-Image-2.1%20running%20fully%20in%20VRAM%20on%20a%2012%20GB%20GPU%2C%20desktop%20app%20%2B%20honest%20benchmark%20vs%20gpt-image-2&url=https%3A%2F%2Fgithub.com%2FMats2208%2Fqwen-image-local)、你的 Discord。
- **晒出你的数据。** 有 10 或 16 GB 的卡？跑 `bash bench/tiers/run.sh`，把 `results.json` 开个 issue 发出来。

## 致谢

[Qwen-Image-2.1](https://github.com/QwenLM/Qwen-Image-2.1) 由阿里巴巴 Qwen 团队出品 · [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 与 [Comfy-Org](https://huggingface.co/Comfy-Org/Qwen-Image-2.1) 的 int8 重打包 · [uv](https://github.com/astral-sh/uv) · [Tauri](https://tauri.app)。基准测试照片来自 Wikimedia Commons；作者与许可证见 [bench/inputs/credits.json](bench/inputs/credits.json)。

## 许可证

本仓库代码为 [MIT](LICENSE)。应用从 Hugging Face 下载的 Qwen-Image-2.1 权重遵循 [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE)，**不授权商用**。ComfyUI 为 GPL-3.0，作为独立进程运行。对 CC BY-SA 基准照片所做的编辑遵循 CC BY-SA 4.0。
