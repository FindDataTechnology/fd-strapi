// research-article（研究文章）——发布前内部标识拦截接线。
//
// 本文件没有任何 db 生命周期钩子可拦 publish（Strapi 5.58 的 content-type
// lifecycles 没有 beforePublish；db 级 beforeCreate 在 publish 内部删掉旧发布
// 行【之后】才触发，在那里抛错会丢已发布内容）。真正的拦截点是 document
// service 中间件 strapi.documents.use()，由下面的模块加载副作用在应用
// register 阶段（loadApplicationContext import 本文件时）幂等注册。
// 共享检查逻辑全部在 src/rules/（见 RULES.md）。

import { registerPublishGuard } from '../../../../rules/publish-guard';

registerPublishGuard((globalThis as { strapi?: unknown }).strapi);

export default {};
