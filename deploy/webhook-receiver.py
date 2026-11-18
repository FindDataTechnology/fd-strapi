#!/usr/bin/env python3
"""fd-strapi publish webhook receiver (the node host service).

Strapi 的 entry.publish webhook 打到这里（容器内经 <webhook-host>:8125，tailnet
段不公网可达），校验 X-Deploy-Token 后串行调起官网构建部署脚本
/opt/fd/fd-web-deploy.sh（flock 防并发；立即 202，构建日志在
/var/log/fd-web-deploy.log）。

- 只 bind <webhook-host>（本机 tailnet IP）：容器可达、公网不可达
- token 在 /opt/fd-strapi/.webhook-token（0600）
- 无/错 token → 401；GET → 405；flock 占用 → 202 already-running
"""
import http.server
import ipaddress
import logging
import os
import secrets
import subprocess

BIND = (os.environ.get("WEBHOOK_BIND_HOST", "127.0.0.1"),
        int(os.environ.get("WEBHOOK_BIND_PORT", "8125")))
TOKEN_FILE = "/opt/fd-strapi/.webhook-token"
DEPLOY_LOCK = "/var/lock/fd-web-deploy.lock"
DEPLOY_CMD = ["/opt/fd/fd-web-deploy.sh"]
DEPLOY_LOG = "/var/log/fd-web-deploy.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler("/var/log/fd-strapi-webhook.log"), logging.StreamHandler()],
)
log = logging.getLogger("fd-strapi-webhook")


def read_token() -> str:
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return ""


class Handler(http.server.BaseHTTPRequestHandler):
    def _deny(self, code: int, msg: str) -> None:
        body = msg.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        token = read_token()
        # 常量时间比较：`!=` 是逐字节短路，耗时随「匹配了多少前缀」变化，
        # 攻击者可据此逐字节把 token 猜出来（经典时序侧信道）。
        # `not token` 那半保持 fail-closed：没配 token 就一律拒。
        supplied = self.headers.get("X-Deploy-Token", "")
        if not token or not secrets.compare_digest(supplied, token):
            log.warning("denied: bad or missing token from %s", self.client_address[0])
            self._deny(401, "unauthorized\n")
            return
        # Strapi 的发布正文不解析——任何带 token 的 POST 都触发一次站点构建，
        # 由 6h cron 兜底语义决定幂等；lock 保证同一时刻只有一次在跑。
        log.info("accepted trigger from %s", self.client_address[0])
        with open(DEPLOY_LOG, "a") as lf:
            proc = subprocess.Popen(
                ["flock", "-n", DEPLOY_LOCK] + DEPLOY_CMD,
                stdout=lf,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        # flock -n 拿不到锁时立即退出码 1——无法区分「正在跑」与「秒败」，
        # 统一 202，由日志判定；拿得到锁则 detach 到后台继续。
        try:
            rc = proc.wait(timeout=1)
            if rc != 0:
                self._deny(202, "already running or instant-fail (see /var/log/fd-web-deploy.log)\n")
                return
        except subprocess.TimeoutExpired:
            pass  # 还在跑 = 正常，detach
        self._deny(202, "deploy triggered\n")

    def do_GET(self) -> None:
        self._deny(405, "post only\n")

    def log_message(self, fmt, *args):  # 静默默认访问日志，走统一 log
        pass


if __name__ == "__main__":
    log.info("listening on %s", BIND)
    http.server.ThreadingHTTPServer(BIND, Handler).serve_forever()
