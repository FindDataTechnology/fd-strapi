import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Server => {
  // 生产对外的根地址（如 https://cms.finddatatech.cloud）。只在设置时写入
  // server.url——Strapi 会用它拼绝对链接（admin 面板入口、上传文件 URL 等）；
  // 本地开发不设置，行为与之前完全一致。
  const publicUrl = env('PUBLIC_URL', '');

  return {
    host: env('HOST', '0.0.0.0'),
    port: env.int('PORT', 1337),
    ...(publicUrl ? { url: publicUrl } : {}),
    // admin 目录保持默认（/admin，config/admin.ts 无 path 配置）
    app: {
      keys: env.array('APP_KEYS')!,
    },
    webhooks: {
      populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
    },
  };
};

export default config;
