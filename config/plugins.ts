import type { Core } from '@strapi/strapi';

const allowedMediaTypes = [
  'image/*',
  'video/*',
  'audio/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.*',
  'text/plain',
  'text/csv',
];

const deniedTypes = [
  'image/svg+xml',
  'application/vnd.microsoft.portable-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sh',
  'text/x-shellscript',
  'application/x-mach-binary',
];

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  // i18n（zh 默认 + en）不用 plugins.ts 配置：Strapi 5.58 的 i18n 插件不读取
  // v4 式的 defaultLocale/locales 键。语言集合与默认值改为两处可复现机制：
  //   1) .env 的 STRAPI_PLUGIN_I18N_INIT_LOCALE_CODE=zh（空库初始化的第一个
  //      locale 及默认 locale）；
  //   2) src/index.ts bootstrap 里的 ensureLocales()（幂等补齐 zh/en 并把默认
  //      设为 zh）。详见 README「i18n」一节。

  // 正文 body（richtext 字段，语义为 markdown 源文本，design.md D3）在后台用
  // 带 md 预览的编辑器渲染；该插件整体替换默认 WYSIWYG，不改变字段存储格式。
  'wysiwyg-react-md-editor': {
    enabled: true,
    config: {
      // 默认工具栏已含标题/加粗/列表/引用/代码/链接/媒体库，够用；如需调整看插件 README。
      // toolbarCommands: [...],
    },
  },
  'users-permissions': {
    config: {
      jwtManagement: 'refresh',
      sessions: {
        httpOnly: true,
      },
    },
  },
  // SSO（strapi-plugin-sso）：管理后台经寻数 Logto 登录（OIDC 授权码流）。
  // 应用 = Logto admin 租户 cms-console（03pozpxtfqj1k5v0296j1），回调
  // /strapi-plugin-sso/oidc/callback 已在 Logto redirectUris。
  // USE_WHITELIST=true：仅白名单邮箱可 SSO 建号/登录——账号生命周期收口在
  // Logto+白名单双闸。凭据经 .env 注入（SSO_OAUTH_*，见 deploy/env.example）。
  'strapi-plugin-sso': {
    enabled: true,
    config: {
      REMEMBER_ME: false,
      OIDC_CLIENT_ID: env('SSO_OIDC_CLIENT_ID'),
      OIDC_CLIENT_SECRET: env('SSO_OIDC_CLIENT_SECRET'),
      OIDC_REDIRECT_URI: env('SSO_OIDC_REDIRECT_URI', 'https://cms.finddatatech.cloud/strapi-plugin-sso/oidc/callback'),
      OIDC_SCOPES: 'openid profile email',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://auth.finddatatech.cloud/oidc/auth',
      OIDC_TOKEN_ENDPOINT: 'https://auth.finddatatech.cloud/oidc/token',
      OIDC_USER_INFO_ENDPOINT: 'https://auth.finddatatech.cloud/oidc/me',
      OIDC_USER_INFO_ENDPOINT_WITH_AUTH_HEADER: false,
      OIDC_GRANT_TYPE: 'authorization_code',
      USE_WHITELIST: true,
    },
  },
  upload: {
    config: {
      security: {
        allowedTypes: allowedMediaTypes,
        deniedTypes,
      },
    },
  },
});

export default config;
