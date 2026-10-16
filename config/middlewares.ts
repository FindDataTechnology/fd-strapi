import type { Core } from '@strapi/strapi';

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  {
    name: 'strapi::body',
    config: {
      // 默认 1MB 的 JSON/表单体对带长代码块的研究正文不够（413）；媒体
      // multipart 不受此限。放宽到 20MB，与雷池侧约定对齐。
      jsonLimit: '20mb',
      formLimit: '20mb',
    },
  },
  'strapi::session',
  // session cookie 的 secure 标志默认按 NODE_ENV==='production' 硬开；本部署
  // TLS 由雷池终结、回源 http（X-Forwarded-Proto 不被 koa-session 的 secure
  // 判定采信），secure cookie 发不出去 = 管理后台会话全断。显式关掉：
  // 浏览器↔雷池仍是 HTTPS，Cookie 传输段不降级（传输层安全由反代保证）。
  {
    name: 'strapi::session',
    config: { secure: false },
  },
  'strapi::favicon',
  'strapi::public',
];

export default config;
