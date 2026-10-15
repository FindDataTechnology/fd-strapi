# 星研研究员投稿指南（Strapi 后台）

面向星研线的研究员（作者）。你只需要一个浏览器，不需要 git、不需要命令行。

## 你的账号

- 后台地址：`https://cms.finddatatech.cloud/admin`（域名开通前，由管理员提供临时入口）
- 账号由管理员开通（邀请邮件链接设密码）；你的角色是 **作者（Author）**
- 作者能做：建草稿、改自己的草稿。**不能**：发布、删别人的内容

## 投稿五步

1. **登录后台** → 左侧选择内容类型：内参（Briefing）/ 学院课程（Course）/ 研究（Research Article）
2. **点 "Create new entry"**，先写 zh 版本（默认语言）：
   - `slug`：URL 标识，用英文短横线小写（如 `retrieval-eval-notes`）；**zh 与 en 必须填同一个 slug**
   - 标题/摘要/日期/标签/来源：正常填写（日期格式 YYYY-MM-DD）
   - 正文（body）：直接写或粘贴 **Markdown**，右侧有预览
3. **补 en 版本**：右上角语言切换到 English → "Create" → 填英文内容（slug 与 zh 相同）。**zh/en 都就绪才能上线**——缺一侧，主编发布后构建会失败，文章上不了线。
4. **点 Save**（草稿）。你可以在草稿里反复修改。
5. **通知主编审发**。主编点 Publish 后几分钟内文章上线官网。

## 发布被拦（红色报错）怎么办

发布时系统会做**内部标识机检**：内容里出现内部节点坐标、内部仓库名、凭据形态等会被当场拦下，报错会告诉你**命中的类别、在哪个字段、哪一句**。把那处改干净（用对外可说的表述）再让主编发布即可。这是保护你也保护公司——拦的是不该对外出现的东西。

## 常见问题

- **图片**：正文里先用占位描述，需要配图时联系管理员（媒体库由管理员统一管理）。
- **改已发布的文章**：直接改草稿侧 → 通知主编重新 Publish → 几分钟后线上更新。
- **写了一半想留档**：Save 即可，草稿不会对外，也不会进构建。
- **AI 起草的稿子**：可以让 AI 按模板写好 Markdown，你粘进后台再改。

## 给管理员

- 开账号：Settings → Administration panel → Roles 用默认 Author（作者）/Editor（编辑）即可；邀请邮件制。
- 只读 token（官网构建用）：Settings → API Tokens → Read-only（已建 `official-web-read`，变更需同步 `/opt/fd/fd-web-build.env` 于构建机）。
- 规则清单（机检）更新：改 finddata `docs/xingyan/scripts/internal-identifiers.txt` → 构建机跑 `rules:sync` 产物覆盖到 `/opt/fd-strapi/rules/internal-identifiers.txt`（覆盖写，勿 rm+新建）→ 守卫免重启即时生效。
