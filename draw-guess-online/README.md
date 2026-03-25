# SketchWave 你画我猜

一个支持多人联机、实时画板同步、房间分享和数据库题库管理的派对游戏网站。

## 功能

- 实时联机房间与聊天猜词
- Socket.IO 画板同步
- 房主开局、轮流作画、计时与积分
- 公网邀请链接
- 管理员登录后台
- 题库手动新增、批量导入、删除
- PostgreSQL 持久化题库

## 本地开发

1. 安装依赖

```bash
npm install
```

2. 按需配置环境变量

```bash
copy .env.example .env
```

3. 启动开发环境

```bash
npm run dev
```

前端默认在 `http://localhost:5173`，服务端默认在 `http://localhost:3001`。

## 环境变量

参考 [.env.example](D:\Personal\Documents\VIBE CODING\draw-guess-online\.env.example)

- `PORT`: 服务端端口，部署平台通常会自动注入
- `DATABASE_URL`: PostgreSQL 连接串
- `DATABASE_SSL`: 默认开启 SSL，如本地数据库不需要可设为 `false`
- `ADMIN_PASSWORD`: 题库后台管理员密码

## 题库导入格式

支持两种批量格式：

```txt
机器人
动物,北极熊
美食|寿司
```

- 每行一个词时，分类默认是 `默认`
- 使用 `分类,词语` 或 `分类|词语` 时会写入对应分类

## 生产部署

推荐方案：Render Web Service + Render Postgres 或 Neon Postgres。

### Render 部署

1. 把仓库推到 GitHub
2. 在 Render 新建 `Web Service`
3. 构建命令填写：`npm install && npm run build`
4. 启动命令填写：`npm start`
5. 配置环境变量：
   - `ADMIN_PASSWORD`
   - `DATABASE_URL`
   - `DATABASE_SSL=true`
6. 首次部署完成后，直接访问 Render 分配的公网域名

### 数据库

服务启动时会自动创建 `word_bank` 表，并在空库时写入一批默认词语。

## 适合这套项目的官方文档

- [Render Node/Express 部署文档](https://render.com/docs/deploy-node-express-app)
- [Render Web Service 文档](https://render.com/docs/web-services)
- [Render Postgres 文档](https://render.com/docs/postgresql)
- [Neon 连接 Node/Postgres 文档](https://neon.com/docs/get-started-with-neon/connect-neon)
