<div align="center">

# fn-danmu - 飞牛影视弹幕增强

为飞牛影视（fnOS）添加弹幕支持，基于 danmu-api 弹幕数据源，通过反向代理自动注入弹幕脚本到播放页面。

**本仓库基于[右咖啡(rgcaafe)](https://github.com/rgcaafe/fn-danmu)原项目修改，修复飞牛影视新版 API 签名校验导致弹幕无法自动匹配的问题。**

</div>

---

## 与原项目的区别

飞牛影视更新后（约 2026年6月），`/v/api/v1/play/info` 接口新增了请求签名校验（`authx` + `authorization` 头）。原项目 `danmaku.js` 自行调用该 API 不带签名，返回 `5000 invalid sign`，导致弹幕自动匹配失效。

**本修复版**将视频信息获取从浏览器侧直接调用 API 改为**代理层拦截**：
- `server.js`：透传 `play/info` 响应时解析并缓存视频信息，暴露本地接口 `/dm-api/video-info`
- `danmaku.js`：改为轮询代理层的视频信息接口，获取标题/季/集后自动匹配弹幕

## 效果展示

播放视频时自动匹配弹幕，弹幕从右向左滚动飘过播放器画面。

支持 PC 浏览器 / TV 浏览器 / 任何带浏览器的设备，无需安装任何扩展或 App。

**功能列表：**
- 自动匹配：根据视频标题 + 季/集信息自动匹配弹幕
- 手动搜索：按动漫名搜索 → 选集 → 加载弹幕
- 换集自动加载
- 弹幕行避让（不重叠）
- 点击弹幕暂停 3 秒并显示时间戳
- 弹幕参数可调
- HTTP / HTTPS 双协议支持
- 飞牛 SPA 内跳转自动重新注入

## 实现原理

```
┌──────────────┐      ┌───────────────────────┐      ┌──────────────┐
│  浏览器 / TV  │      │   danmaku-proxy       │      │  飞牛影视     │
│              │      │   (Docker)            │      │  (fnOS)      │
│  访问 :3000  │─────→│                       │─────→│  :5666       │
│              │      │  ① 拦截页面请求        │      │              │
│              │ HTML │  ② 去掉缓存头          │ HTML│  返回原始页面  │
│  拿到注入后的 │◄─────│  ③ 注入弹幕脚本        │◄─────│              │
│  HTML 页面   │      │  ④ 透传视频流/API/资源  │      └──────────────┘
│              │      │  ⑤ 拦截play/info响应   │
│              │      │     缓存视频信息        │
│  弹幕脚本运行 │      │                       │      ┌──────────────┐
│  请求弹幕数据 │─────→│  /dm-api/* 转发       │─────→│  danmu-api   │
│              │ JSON │                       │ JSON │  :9321       │
│  渲染弹幕    │◄─────│                       │◄─────│              │
└──────────────┘      └───────────────────────┘      └──────────────┘
```

## 前置要求

| 组件 | 说明 |
|---|---|
| Docker + Docker Compose | 容器运行环境 |
| 飞牛影视（fnOS）| 已部署并可访问 |
| [danmu-api](https://github.com/huangxd-/danmu_api) | 弹幕数据服务，已部署并可访问 |

## 部署方式一：使用预构建镜像（推荐）

**1. 创建目录和配置文件**

```bash
mkdir fn-danmaku && cd fn-danmaku
```

创建 `docker-compose.yml`：

```yaml
services:
  danmaku-proxy:
    image: chanhuan01/fntv-danmu:latest
    ports:
      - "3000:3000"
      - "3443:3443"
    environment:
      - FN_URL=http://192.168.10.252:5666    # 改成你的飞牛影视地址
      - DM_URL=http://192.168.10.252:9321    # 改成你的 danmu-api 地址
      - PORT=3000
      - HTTPS_PORT=3443
    volumes:
      - ./certs:/app/certs
    restart: unless-stopped
    init: true
```

**2. 启动**

```bash
docker compose up -d
```

**3. 确认启动成功**

```bash
docker compose logs -f
```

看到以下内容说明正常：

```
[启动] 飞牛: http://192.168.10.252:5666
[启动] 弹幕: http://192.168.10.252:9321
[就绪] HTTP:  http://<NAS-IP>:3000
[就绪] HTTPS: https://<NAS-IP>:3443
```

**4. 使用**

浏览器访问 `http://<NAS-IP>:3000`（或 `https://<NAS-IP>:3443`），后续操作和直接访问飞牛一样，但会多出弹幕功能。

**更新版本：**

```bash
docker compose pull
docker compose up -d
```

## 部署方式二：从源码构建

```bash
git clone https://github.com/chanhuan1/fn-danmu.git
cd fn-danmu
```

修改 `docker-compose.yml` 中的 `FN_URL` 和 `DM_URL`，然后：

```bash
docker compose up -d --build
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `FN_URL` | 飞牛影视地址（需带 `http://` 或 `https://`） | `http://192.168.10.252:5666` |
| `DM_URL` | danmu-api 弹幕服务地址 | `http://192.168.10.252:9321` |
| `PORT` | 代理 HTTP 端口 | `3000` |
| `HTTPS_PORT` | 代理 HTTPS 端口（自签证书） | `3443` |

## HTTPS 说明

代理同时监听 HTTP 和 HTTPS：

- **HTTP（:3000）**：直接使用
- **HTTPS（:3443）**：首次启动时自动生成自签证书（保存在 `./certs/`），浏览器会提示不安全，点"继续访问"即可

如需使用自己的证书，将文件放到 `./certs/` 目录：

```
./certs/key.pem   # 私钥
./certs/cert.pem  # 证书
```

## 使用指南

### 自动匹配

播放视频后，脚本自动从代理层获取视频标题 + 季/集信息，调用 danmu-api 匹配弹幕。

### 手动搜索

1. 点击播放器右上角的「弹幕」按钮
2. 在搜索框输入动漫名称，点「搜索」
3. 从搜索结果中选择动漫 → 选择具体集数 → 加载

### 弹幕设置

点击「弹幕」按钮 → 切换到「⚙ 设置」标签，可调整字号、行间距、透明度、速度、密度、显示区域、时间偏移等参数。设置自动保存到浏览器 localStorage。

## 鸣谢

- [右咖啡(rgcaafe)](https://github.com/rgcaafe/fn-danmu) - 原项目和镜像
- [danmu-api](https://github.com/huangxd-/danmu_api) - 弹幕数据服务

## License

[MIT](LICENSE)
