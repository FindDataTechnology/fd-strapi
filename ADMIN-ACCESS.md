# 后台账号与权限（星研 CMS / Strapi）

## 两层模型

- **身份（你是谁）**：Logto 管。停用 Logto 身份即登不进 cms；`USE_WHITELIST=true` 是第二道闸
  （不在白名单连建号都不允许）。
- **权限（你能干什么）**：Strapi 管。角色在 Strapi 库（Super Admin / Editor / Author），
  **不是** Logto 的角色。提权/降权都在 Strapi 侧。

## 当前账号（2026-10-16）

| 账号 | 登录方式 | 角色 | 用途 |
|---|---|---|---|
| `aloadtree@gmail.com` | Logto SSO（`/sso`） | **Super Admin**（唯一超管） | 主编/管理员日常 |
| `xingyan-admin@finddatatech.cloud` | 本地密码 | Editor（已降级） | Logto 不可用时的应急通道；投稿够用、设置不可改 |

应急凭据在节点 `/opt/fd-strapi/.admin-credentials`（600）。

## 日常操作配方（节点 cheap-1，库在 compose 的 postgres）

```bash
cd /opt/fd-strapi
docker compose exec -T postgres psql -U strapi -d strapi
```

**看账号与角色**
```sql
select u.id, u.email, r.name
from admin_users u
left join admin_users_roles_lnk l on l.user_id=u.id
left join admin_roles r on r.id=l.role_id
order by u.id;
-- 角色：1=Super Admin, 2=Editor, 3=Author
```

**提/降权**（把 `<user_id>` 挂到 `<role_id>`，先删旧再插新的）
```sql
delete from admin_users_roles_lnk where user_id=<user_id>;
insert into admin_users_roles_lnk (user_id, role_id, role_ord, user_ord)
values (<user_id>, <role_id>, 1, 1);
```

**SSO 白名单**（`published_at` **必须非空**，document service 会过滤 draft 行）
```sql
-- 加
insert into "strapi-plugin-sso_whitelists" (document_id, email, created_at, updated_at, published_at)
select md5(random()::text), '<email>', now(), now(), now()
where not exists (select 1 from "strapi-plugin-sso_whitelists" where email='<email>');
-- 查
select id, email, published_at from "strapi-plugin-sso_whitelists";
-- 删
delete from "strapi-plugin-sso_whitelists" where email='<email>';
```

**应急恢复超管**（Logto 不可用时）
```sql
update admin_users_roles_lnk set role_id=1 where user_id=1; -- 本地账号回 Super Admin
```
恢复后记得降回 Editor（`role_id=2`）。

## 研究员账号开通流程

1. 确认其 Logto 身份的**实际登录邮箱**（不是 admin 租户账号的 primary_email——两者无关；
   实测踩过：照搬 admin 租户邮箱会被白名单拒）。
2. Logto 侧按需建/启用身份。
3. 白名单加该邮箱。
4. 首次 SSO 登录即自动建 Strapi 用户（默认 Author），需要更高权限再按上面提权。

## 登录入口

- 统一登录：https://cms.finddatatech.cloud/sso （静态跳转 → `/strapi-plugin-sso/oidc`）
- 本地密码备用：https://cms.finddatatech.cloud/admin
