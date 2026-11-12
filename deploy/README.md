# AlgoFlow 部署

网页和同步接口（sync-api）由 Nginx 放在同一个 HTTPS 域名下：静态网页在 `/`，`/v1/` 和 `/healthz` 转发到只监听 `127.0.0.1:8787` 的 sync-api。`/ai-api` 不转发，1.1.0 不含 AI。

本目录的文件只有占位符（`example.com`、`{{...}}`），部署时在服务器上替换；真实域名、备案号、邮箱和姓名不提交进仓库（`AGENTS.md` 7.2）。公共同步服务器尚未上线。

| 文件 | 安装到 |
|---|---|
| `nginx.conf.example` | `/etc/nginx/conf.d/algoflow.conf` |
| `algoflow-sync-api.service.example` | `/etc/systemd/system/algoflow-sync-api.service` |
| `privacy.template.html` | 填好占位符后放到 `/var/www/algoflow/privacy.html` |

## 前提

- 中国大陆的 Linux 服务器。下面的命令以 Ubuntu 22.04/24.04 为例，其他发行版按实际调整软件包和 Nginx 配置目录。
- 已备案的域名，A 记录指向服务器。
- Node 24：SQLite 存储用的是内置的 `node:sqlite`，换 Node 大版本前先在服务器上跑 sync-api 测试。
- 云服务商安全组和系统防火墙只开放 SSH、80、443。
- 80 和 443 没有被其他程序占用：`sudo ss -tlnp | grep -E ':(80|443) '` 应该只有 nginx，或者没有输出。比如 frps 的 `vhostHttpsPort = 443` 会占住 443，要先改成别的端口。

| 路径 | 内容 | 所有者 |
|---|---|---|
| `/opt/algoflow` | 仓库检出，sync-api 只读 | 登录用户 |
| `/var/lib/algoflow/sync.db` | 同步数据库 | `algoflow`，目录 0700 |
| `/var/backups/algoflow` | 每日备份，保留 7 天 | `algoflow`，目录 0700 |
| `/var/www/algoflow` | 网页构建产物和 `privacy.html` | 登录用户 |
| `/var/log/nginx/algoflow` | 访问日志和错误日志，保留 7 天 | root |

下面的命令都在仓库目录 `/opt/algoflow` 里、用登录服务器的普通用户执行，需要 root 的已加 `sudo`。先设置域名：

```sh
domain=example.com    # 换成真实域名
```

## 1. 安装

```sh
sudo apt update
sudo apt install nginx sqlite3 git certbot rsync
# Node 24：NodeSource 源（如下），或 nodejs.org、npmmirror 的官方二进制包
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install nodejs
node --version        # v24.x
command -v node       # 不是 /usr/bin/node 时，改 unit 里的 ExecStart

sudo useradd --system --home-dir /var/lib/algoflow --shell /usr/sbin/nologin algoflow
sudo install -d -o "$USER" /opt/algoflow /var/www/algoflow
git clone https://github.com/CDUESTC-OpenAtom-Open-Source-Club/AlgoFlow.git /opt/algoflow
cd /opt/algoflow
git checkout <发布标签或提交>
node --test services/sync-api/test/*.test.mjs
```

- 已经装了 nginx（比如来自 nginx.org 的源）时，从 `apt install` 里去掉 nginx，否则会顺带升级它。
- 服务器访问 GitHub 慢时，可以在本机 `git bundle create algoflow.bundle main` 后上传，再 `git clone algoflow.bundle /opt/algoflow`。

## 2. 网页

```sh
cd /opt/algoflow/apps/web
npm ci                # 国内可加 --registry=https://registry.npmmirror.com
VITE_ICP_RECORD='<网站备案号>' VITE_PRIVACY_URL=/privacy.html npm run build -- --mode hosted
rsync -a --delete --exclude privacy.html dist/ /var/www/algoflow/
cd /opt/algoflow
```

- 页脚用网站备案号，不带 `-数字A` 后缀；带后缀的是 APP 备案号，填在 AGC。
- 构建开关见 `apps/web/README.md`。服务器内存小于 1 GB 时，可以在本机构建后把 `dist/` 上传到 `/var/www/algoflow/`，同样排除 `privacy.html`。
- 构建后检查隐私政策地址：`` grep -oh '[^`"]*privacy\.html' dist/assets/*.js | sort -u `` 应该只输出 `/privacy.html`。

本机是 Windows、没有 `rsync` 时，在本机的 `apps/web` 里用同样的命令构建。在 Git Bash 里构建要在命令前加 `MSYS_NO_PATHCONV=1`，否则 Git Bash 会把 `/privacy.html` 改成 `C:/Program Files/Git/privacy.html`，构建不报错，链接却打不开。构建后这样上传：

```sh
tar -C dist -cf - . | ssh <用户>@<服务器> \
  'cd /var/www/algoflow && find . -mindepth 1 ! -name privacy.html -delete && tar --no-same-owner --no-same-permissions -xf -'
```

## 3. 隐私政策

运营者名称由你自己输入，不经过任何文件：

```sh
read -r -p '运营者名称：' operator
read -r -p '联系邮箱：' email
sed -e "s|{{OPERATOR_NAME}}|$operator|g" \
    -e "s|{{CONTACT_EMAIL}}|$email|g" \
    -e "s|{{DOMAIN}}|$domain|g" \
    -e "s|{{EFFECTIVE_DATE}}|$(date +%Y年%-m月%-d日)|g" \
    deploy/privacy.template.html > /var/www/algoflow/privacy.html
grep -c '{{' /var/www/algoflow/privacy.html    # 应为 0
```

- 模板按当前代码的数据流写成：存什么、保留多久、怎么删除，不是端到端加密。改动数据流的 PR 要同时改模板，部署前再对照代码核对一遍。
- 手机应用里随包的隐私政策和 AGC 填的隐私政策网址（`https://<域名>/privacy.html`）要和这一份一致。

## 4. sync-api

```sh
sed "s/example\.com/$domain/g" deploy/algoflow-sync-api.service.example \
  | sudo tee /etc/systemd/system/algoflow-sync-api.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now algoflow-sync-api
curl -fsS http://127.0.0.1:8787/healthz      # {"status":"ok"}
sudo journalctl -u algoflow-sync-api -n 5    # 应有 storage=sqlite
```

- 日志里的 `ExperimentalWarning: SQLite is an experimental feature` 是 Node 24 的正常提示。
- 限额用环境变量调整（`services/sync-api/src/server.mjs` 末尾列出全部变量），在 unit 里加 `Environment=` 后 `daemon-reload` 并重启。
- 磁盘：数据库最坏约为 `SYNC_LIMIT_WORKSPACES × SYNC_LIMIT_WORKSPACE_BYTES`（默认 1000 × 20 MiB，约 20 GiB；单工作区限额包含草稿历史版本），7 份压缩备份另算。磁盘小时调低 `SYNC_LIMIT_WORKSPACES`。

服务日志保存在 journald 里，从备份恢复时要用到（见「恢复」）。保留 30 天，与隐私政策一致：

```sh
sudo install -d /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nMaxRetentionSec=30day\nMaxFileSec=1day\n' \
  | sudo tee /etc/systemd/journald.conf.d/algoflow.conf >/dev/null
sudo systemctl restart systemd-journald
```

这个设置对整台服务器的 journald 生效，服务器只跑 AlgoFlow 时没有影响。

## 5. 证书和 Nginx

完整配置引用的证书文件要先存在，所以首次申请证书时先用一个只回应验证请求的临时配置。

下面的命令按 Ubuntu 自带的 nginx 写。nginx 来自 nginx.org 的源时（`/etc/nginx/nginx.conf` 里是 `user nginx;`），有三处要改：

- 默认站点是 `/etc/nginx/conf.d/default.conf`，没有 `sites-enabled`。把 `rm` 那一行换成 `sudo mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.disabled`。
- 日志轮转配置里的 `create 0640 www-data adm` 改成 `create 0640 nginx adm`。
- 系统的 `/etc/logrotate.d/nginx` 默认是 `rotate 52`，最后一条 `sed` 改成 `s/rotate 52/rotate 6/`。

```sh
sudo install -d /var/www/certbot /var/log/nginx/algoflow
sudo rm -f /etc/nginx/sites-enabled/default    # 它也是 default_server，会和配置里的兜底 server 冲突
printf 'server {\n    listen 80;\n    server_name %s;\n    location /.well-known/acme-challenge/ { root /var/www/certbot; }\n}\n' "$domain" \
  | sudo tee /etc/nginx/conf.d/algoflow-acme.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d "$domain" \
  -m <证书通知邮箱> --agree-tos --no-eff-email --deploy-hook 'systemctl reload nginx'
sudo rm /etc/nginx/conf.d/algoflow-acme.conf

sed "s/example\.com/$domain/g" deploy/nginx.conf.example \
  | sudo tee /etc/nginx/conf.d/algoflow.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run    # 在非交互的 ssh 命令里运行要加 --no-random-sleep-on-renew，否则会先随机等待最多 8 分钟
```

nginx 1.19.4 以上（`nginx -v`）可以打开配置里注释掉的 TLS 兜底：用其他域名或 IP 访问 443 时直接拒绝握手，不返回 AlgoFlow 的证书。把上面安装配置的命令换成：

```sh
sed -e "s/example\.com/$domain/g" -e '/^# server {$/,/^# }$/s/^# //' deploy/nginx.conf.example \
  | sudo tee /etc/nginx/conf.d/algoflow.conf >/dev/null
```

用云服务商签发的证书时，跳过 certbot，把证书放到 `/etc/nginx/ssl/` 并改 `ssl_certificate` 两行，记得在到期前更换。

访问日志只保留 7 天（当天加 6 份轮转）：

```sh
sudo tee /etc/logrotate.d/algoflow-nginx >/dev/null <<'EOF'
/var/log/nginx/algoflow/*.log {
    daily
    rotate 6
    missingok
    notifempty
    compress
    delaycompress
    create 0640 www-data adm
    sharedscripts
    postrotate
        nginx -s reopen
    endscript
}
EOF
sudo logrotate --debug /etc/logrotate.d/algoflow-nginx
# Nginx 自己的 error.log 也可能有 IP，系统默认保留 14 天，改成同样 7 天
sudo sed -i 's/rotate 14/rotate 6/' /etc/logrotate.d/nginx
```

## 6. 防火墙

```sh
sudo ufw allow OpenSSH    # SSH 改过端口时放行实际端口
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

云服务商的安全组同样只放行这三个端口。sync-api 只监听 127.0.0.1，防火墙是第二道保护。

- 服务器上还有其他对外服务（比如 frps 的 7000）时，`ufw enable` 之前要先放行它们的端口，否则会立即断开。也可以不开 ufw，只靠安全组。
- 安全组里的 SSH 只放行自己的 IP 时，家庭宽带的 IP 变了就连不上，要去控制台更新规则，或者用云服务商网页上的远程连接。

## 7. 上线检查

在另一台机器上：

```sh
curl -fsS https://$domain/healthz                       # {"status":"ok"}
curl -sI http://$domain/ | head -1                      # 301
curl -sI https://$domain/ | grep -iE 'strict-transport|content-security'
curl -s -o /dev/null -w '%{http_code}\n' https://$domain/ai-api/   # 404
curl -m 5 http://<服务器 IP>:8787/healthz                # 必须连不上
```

再用浏览器打开网页：页脚有备案号，隐私政策链接能打开；「手机远程」开启前有上传说明，开启后能扫码配对，设备列表显示「这台电脑」和手机。

## 备份

每天一份 `VACUUM INTO` 快照，服务运行时也能做；所有快照 7 天后删除，与隐私政策一致。

```sh
sudo install -d -o algoflow -g algoflow -m 0700 /var/backups/algoflow
sudo tee /usr/local/bin/algoflow-backup >/dev/null <<'EOF'
#!/bin/sh
# Snapshot of the AlgoFlow sync database. Every snapshot is deleted after 7 days.
set -eu
umask 077
dir=/var/backups/algoflow
name="${1:-sync}-$(date +%F-%H%M)"
rm -f "$dir/.$name.db" "$dir/.$name.db.gz"
sqlite3 /var/lib/algoflow/sync.db "VACUUM INTO '$dir/.$name.db'"
gzip "$dir/.$name.db"
mv "$dir/.$name.db.gz" "$dir/$name.db.gz"
find "$dir" -name '*.db.gz' -mtime +6 -delete
EOF
sudo chmod 755 /usr/local/bin/algoflow-backup

sudo tee /etc/systemd/system/algoflow-backup.service >/dev/null <<'EOF'
[Unit]
Description=AlgoFlow sync database backup

[Service]
Type=oneshot
User=algoflow
ExecStart=/usr/local/bin/algoflow-backup
EOF
sudo tee /etc/systemd/system/algoflow-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Daily AlgoFlow sync database backup

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now algoflow-backup.timer
sudo systemctl start algoflow-backup.service && sudo ls -l /var/backups/algoflow
```

备份包含所有同步的草稿。复制到服务器以外时要加密，也要在 7 天内删除。

## 恢复

旧备份不包含备份之后的修改和删除，直接放回去会出两个问题：

- 客户端记住的游标和版本号在恢复后的数据库里不存在。所以要给每个工作区换新的 epoch：客户端下次拉取时收到 `reset`，重新上传本地草稿，备份之后的修改只要还在某台设备上就不会丢。
- 备份之后被删除的工作区和设备会回来。所以要按 sync-api 日志里的「Workspace deleted」「Device removed」重新删除。

备份之后新建的工作区和新加入的设备会丢失，这些设备会收到 401，重新扫码后本地草稿照常上传。

```sh
sudo ls -l /var/backups/algoflow
backup=/var/backups/algoflow/sync-<日期时间>.db.gz    # 要恢复的那一份
since="$(sudo date -r "$backup" +%F) 00:00"           # 从备份当天零点起；多删的 ID 早已不存在，不会出错

sudo systemctl stop algoflow-sync-api
sudo install -d -o algoflow -g algoflow -m 0700 /var/lib/algoflow/before-restore
sudo sh -c 'mv /var/lib/algoflow/sync.db* /var/lib/algoflow/before-restore/'
sudo sh -c "gunzip -c '$backup' > /var/lib/algoflow/sync.db"
sudo chown algoflow:algoflow /var/lib/algoflow/sync.db
sudo chmod 600 /var/lib/algoflow/sync.db

# 只接受 UUID 形式的 ID，日志内容不会变成任意 SQL。
sudo journalctl -u algoflow-sync-api --since "$since" -o cat | sed -nE \
  -e "s/.*Workspace deleted\. workspace_id=([0-9a-f-]{36}).*/DELETE FROM workspaces WHERE workspace_id = '\1';/p" \
  -e "s/.*Device removed\. workspace_id=([0-9a-f-]{36}) device_id=[0-9a-f-]{36} workspace_deleted=true.*/DELETE FROM workspaces WHERE workspace_id = '\1';/p" \
  -e "s/.*Device removed\. workspace_id=[0-9a-f-]{36} device_id=([0-9a-f-]{36}) workspace_deleted=false.*/DELETE FROM devices WHERE device_id = '\1';/p" \
  > /tmp/algoflow-redelete.sql
# foreign_keys 打开后，删除工作区会连带删除它的设备、草稿和历史。
{ echo 'PRAGMA foreign_keys = ON;'; echo 'BEGIN;'; cat /tmp/algoflow-redelete.sql
  echo 'UPDATE workspaces SET epoch = lower(hex(randomblob(16)));'; echo 'COMMIT;'; } \
  | sudo -u algoflow sqlite3 /var/lib/algoflow/sync.db
rm /tmp/algoflow-redelete.sql

sudo systemctl start algoflow-sync-api
curl -fsS http://127.0.0.1:8787/healthz
```

确认服务正常后删除 `before-restore`：`sudo rm -r /var/lib/algoflow/before-restore`。迁移服务器时先停服务再备份，备份是完整的，恢复时可以跳过换 epoch 和重新删除。

## 升级和回滚

```sh
sudo -u algoflow /usr/local/bin/algoflow-backup pre-upgrade    # 单独命名，不会被当天的定时备份覆盖
sudo -u algoflow sqlite3 /var/lib/algoflow/sync.db 'PRAGMA user_version'    # 记下迁移版本
git fetch && git checkout <新版本>
node --test services/sync-api/test/*.test.mjs
# apps/web 有改动时按第 2 步重新构建
sudo systemctl restart algoflow-sync-api
curl -fsS https://$domain/healthz
sudo -u algoflow sqlite3 /var/lib/algoflow/sync.db 'PRAGMA user_version'
```

回滚：

- 迁移版本没变：`git checkout <旧版本>`，重启服务；网页有改动时重新构建。
- 迁移版本变了：旧代码会拒绝启动，日志里是 `SYNC_DB_SCHEMA_TOO_NEW`。先 `git checkout <旧版本>`，再按「恢复」用 `pre-upgrade-*.db.gz` 恢复。升级后到回滚前的修改由客户端重新上传。

## 监控

- 外部：从服务器以外每 5 分钟访问一次 `https://<域名>/healthz`，比如云服务商的站点监控，或另一台机器上的 `curl -fsS --max-time 10`。
- 日志：`sudo journalctl -u algoflow-sync-api -p warning --since today`。`SERVER_AT_CAPACITY` 表示工作区数到了上限，`Request rate limited` 是限流，`Sync request failed` 是 500。
- 磁盘：`df -h /var/lib/algoflow /var/backups/algoflow`。
- 证书：`sudo certbot certificates`，以及 `systemctl list-timers certbot.timer`。

## 发布候选环境

送审和发布前，在同一台服务器上用子域名跑候选版本：独立的检出、用户、端口（8797）、数据库、网页目录和日志文件，测试数据不进正式库，也不做备份。子域名需要单独的 DNS 记录，已备案域名的子域名不用另外备案。

```sh
rc=rc.$domain
sudo useradd --system --home-dir /var/lib/algoflow-rc --shell /usr/sbin/nologin algoflow-rc
sudo install -d -o "$USER" /opt/algoflow-rc /var/www/algoflow-rc
git fetch && git worktree add --detach /opt/algoflow-rc <候选提交>
# 网页：在 /opt/algoflow-rc/apps/web 按第 2 步构建，rsync 到 /var/www/algoflow-rc/，并复制 privacy.html

sed -e "s/example\.com/$rc/g" -e 's/8787/8797/g' -e 's/^Description=.*/& (release candidate)/' \
    -e 's/^User=algoflow$/User=algoflow-rc/' -e 's/^Group=algoflow$/Group=algoflow-rc/' \
    -e 's/^StateDirectory=algoflow$/StateDirectory=algoflow-rc/' \
    -e 's|/var/lib/algoflow/|/var/lib/algoflow-rc/|' -e 's|^WorkingDirectory=/opt/algoflow$|WorkingDirectory=/opt/algoflow-rc|' \
    deploy/algoflow-sync-api.service.example | sudo tee /etc/systemd/system/algoflow-sync-api-rc.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now algoflow-sync-api-rc

# 兜底 server 已经回应所有域名的证书验证，可以直接申请
sudo certbot certonly --webroot -w /var/www/certbot -d "$rc" \
  -m <证书通知邮箱> --agree-tos --no-eff-email --deploy-hook 'systemctl reload nginx'
# 去掉 log_format 和兜底 server（正式配置里已有），其余换成候选环境的值
sed -e '/^log_format/d' -e '/^# Any other host name/,/^}/d' \
    -e "s/example\.com/$rc/g" -e 's/8787/8797/g' \
    -e 's|/var/www/algoflow;|/var/www/algoflow-rc;|' \
    -e 's|algoflow/access\.log|algoflow/rc-access.log|' -e 's|algoflow/error\.log|algoflow/rc-error.log|' \
    deploy/nginx.conf.example | sudo tee /etc/nginx/conf.d/algoflow-rc.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

候选环境的日志文件在同一目录，同样按 7 天轮转。只给测试者用时，可以在候选环境的 443 server 里加 `allow <IP>; deny all;`。测试结束后删除数据：

```sh
sudo systemctl disable --now algoflow-sync-api-rc
sudo rm -r /var/lib/algoflow-rc
```
