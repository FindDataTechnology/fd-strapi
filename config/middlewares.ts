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
  'strapi::favicon',
  'strapi::public',
];

export default config;
