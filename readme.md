# GitHub 文件加速代理服务

## 简介

这是一个基于 Cloudflare Workers 的 GitHub 文件加速代理服务，旨在解决 GitHub 文件访问速度慢的问题。通过此服务，您可以快速访问 GitHub 上的文件，包括仓库主页、release 文件、原始文件、Git 克隆、Gist 文件以及 GitHub API 请求。

## 功能特点

- 支持多种 GitHub 资源访问，包括：
  - 仓库主页
  - Release 文件
  - 原始文件
  - Git 克隆
  - Gist 文件
  - GitHub API 请求
- 使用 Cloudflare 的全球 CDN 网络加速文件访问。
- 支持跨域请求，解决跨域问题。
- 支持自定义路由前缀。
- 支持通过白名单限制访问路径。

## 使用方法

### 仓库主页

```plaintext
https://your-domain.com/gh/github.com/user/repo
```

### Release 文件
```plaintext
https://your-domain.com/gh/github.com/user/repo/releases/download/v1.0.0/app.zip
```

### 原始文件
```plaintext
https://your-domain.com/gh/raw.githubusercontent.com/user/repo/main/file.txt
```

### Git 克隆
```plaintext
git clone https://ghx.pp.ua/github.com/user/project.git
```

### Gist 文件
```plaintext
https://your-domain.com/gh/gist.githubusercontent.com/user/gist_id/raw/file.txt
```

### GitHub API
```plaintext
https://your-domain.com/gh/api.github.com/repos/fatedier/frp/releases/latest
```

## 配置说明

### 基本配置
- `ASSET_URL`：静态文件的 URL，通常不需要修改。

- `PREFIX`：自定义路由前缀，例如 `/gh/`。注意，少一个杠都会导致错误。

- `Config.jsdelivr`：是否使用 jsDelivr 镜像，0 为关闭，1 为开启。

- `whiteList`：白名单，只有路径中包含白名单中的字符才会通过。

### 示例配置

```JavaScript
const ASSET_URL = 'https://kuwinet.github.io/CF-Ghproxy/'
const PREFIX = '/gh/'
const Config = {
    jsdelivr: 0
}
const whiteList = ['/username/']
```

## 部署说明

- 将代码部署到 `Cloudflare Workers`。
- 配置域名解析，将域名指向 `Cloudflare`。
- 根据需要调整配置参数。

## 注意事项

- 确保 `Cloudflare Workers` 的配置允许重定向和代理请求。
- 如果仓库的主分支不是 `main`（如 `master`），需要调整代码中的默认路径。
- 白名单 `whiteList` 可以用来限制访问的路径，提高安全性。
  
## 贡献指南

### 欢迎贡献代码和建议！请遵循以下步骤：

- Fork 本项目。

- 创建您的功能分支：`git checkout -b feature/YourFeature`

- 提交您的更改：`git commit -m 'Add some feature`

- 推送分支：`git push origin feature/YourFeature`

- 创建新的 `Pull Request`


## 许可证
本项目采用 MIT 许可证，详情请参阅 LICENSE 文件。
