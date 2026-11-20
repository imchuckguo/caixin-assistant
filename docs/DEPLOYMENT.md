# 部署团队服务

公开 GitHub 仓库存放源代码，不能直接运行需要持久化数据库的团队 API。本版本提供可部署服务，没有预置公共服务器。

## 环境

- Node.js 24.14.0 或更高版本，或者 Docker Compose。
- 一个可持久保存数据的单实例服务器。
- 公网使用 HTTPS 反向代理和域名。只在本机测试时可以用 HTTP localhost/127.0.0.1。

SQLite 在 Node 24.14 中仍会输出实验性 API 提示；已在该版本测试，不承诺跨主要版本兼容。生产升级先备份并验证。

## 1. 设置部署凭据

在仓库根目录执行：

```sh
cp .env.example .env
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {appendFileSync} from "node:fs"; appendFileSync(".env", "\nCAIXIN_CREATE_TOKEN=" + randomBytes(32).toString("base64url") + "\n")'
chmod 600 .env
```

`.env` 不提交 GitHub。空创建凭据会阻止启动。创建凭据只给负责创建团队的人；它不是成员日常同步令牌。若凭据泄漏，更换该值并重启服务。

## 2. 配置扩展来源

在 Chrome 的扩展管理页查看采芯助手的 ID，将 `.env` 的 `CAIXIN_ORIGINS` 设置为 `chrome-extension://` 加该 ID。多个安装路径产生不同 ID 时，使用逗号分隔；迁移安装路径后也要更新。

这是 CORS 来源列表，不是认证机制；每个业务请求仍校验成员令牌。没有允许的来源时，浏览器连接被拒绝。不要为方便而把所有来源都放行。

## 3. 本机运行

```sh
node --env-file=.env server/index.mjs
```

默认只监听 127.0.0.1:8787，数据库写入 data/caixin.sqlite。

```sh
curl --fail http://127.0.0.1:8787/v1/health
```

扩展内输入 `http://127.0.0.1:8787`，授权该精确来源，使用部署创建凭据创建团队。所有测试使用自造数据。

## 4. Docker

```sh
docker compose up --build -d
docker compose ps
```

容器以非 root 用户运行，只向宿主回环地址暴露 8787，数据库保存在 `caixin-data` 命名卷。**不要执行 `docker compose down -v`，否则数据库卷会被删除。**

服务只用于单实例。不能将多个 SQLite 容器随意扩成共享写入集群。限速按直接连接 IP 计算；反向代理会使多个成员共享一个限速桶，团队规模扩大时需要调整服务限速与代理策略。

## 5. HTTPS 入口

在服务器配置已安装的 Caddy 等反向代理，例如：

```caddyfile
team.your-domain.example {
    reverse_proxy 127.0.0.1:8787
}
```

把示例域名替换成你控制的真实域名，完成 DNS 和证书配置后，扩展填写 `https://你的域名`。证书、域名、网络入口及实际云资源需要部署者自行配置；此仓库不自动购买或创建这些资源。

## 邀请和共享

创建者在团队设置中生成单次邀请文本，手动交给同事。同事粘贴邀请、输入昵称并授权服务器来源。邀请默认 24 小时到期，包含团队解密密钥；应视为可授予读取权限的凭据。

每条历史报价都需主动选择共享。自动共享开关只影响此后新建的记录，默认不包含备注。撤回会同步墓碑；管理员移除成员会撤销访问并撤回该成员的云端记录，已下载副本无法追回。管理员退出将关闭整个团队。

正常退出需要连上服务器以撤销成员。服务器不可达时可以“仅断开本机”，但这不会撤销服务器上的成员令牌，之后需要管理员移除该成员。暂停同步保留队列；恢复后再发送。更换服务器须先断开并重新加入，不复用旧服务器令牌。

成员凭据和密钥保存在当前扩展的可信存储中，没有邮箱找回。卸载扩展前应处理团队成员与本地报价备份；JSON 报价备份不包含团队凭据。

## 备份与恢复

普通进程部署，停止服务后复制整个 data 目录并保护备份。容器可以在停止写入时备份卷：

```sh
docker compose stop team
docker compose run --rm --no-deps --entrypoint tar team czf /app/data/caixin-backup.tar.gz -C /app/data caixin.sqlite
docker compose cp team:/app/data/caixin-backup.tar.gz ./caixin-backup.tar.gz
docker compose start team
```

停止进程应使 SQLite 检查点完成；若不是干净停止，必须一起保存 sqlite、-wal 和 -shm 文件，或使用 SQLite 在线备份工具。恢复前停服务，保留当前目录的另一个副本，再还原备份、修复卷中文件属主为容器 node 用户，然后启动健康检查。备份包含认证摘要和密文，仍需要访问保护，不能提交到公开仓库。

## 验证边界

`npm test` 会在本地用合成团队、真实 HTTP 和临时 SQLite 数据库验证协议与加密往返；这不是独立渗透测试或正式密码学审计。公网部署后还需验证 TLS、Origin、持久卷恢复、防火墙、账号/邀请撤销与实际浏览器配置。当前版本没有实际公网部署。
