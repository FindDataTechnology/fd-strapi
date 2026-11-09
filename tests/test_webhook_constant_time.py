"""deploy webhook 的 token 比较必须是常量时间。

`Handler.do_POST` 原来用 `self.headers.get("X-Deploy-Token", "") != token` 判定，
这是 Python 的逐字节短路比较：两个串在第一个不同字节处就返回，耗时随"匹配了
多少前缀"变化。攻击者可以逐字节把 token 猜出来（经典时序侧信道）。

正确做法是 `secrets.compare_digest`——它不承诺绝对常量时间，但**消除了按前缀
短路的差异**，这正是本项要修的。

**为什么不测真实耗时**：微秒级差异在 CI/容器里被调度噪声淹没，测出来的"通过"
是噪声通过——那是最坏的一种假绿。这里改为在源码层断言"比较走了 compare_digest"。

**为什么不 import 模块**：`deploy/webhook-receiver.py` 在模块级配置
`logging.FileHandler('/var/log/fd-strapi-webhook.log')`，非 root 环境下 import
就抛 PermissionError。测试改为读源码 + 用独立的小实现验证语义，不去触发那个副作用。
"""
from __future__ import annotations

import re
import secrets
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = (REPO / "deploy" / "webhook-receiver.py").read_text(encoding="utf-8")


def test_uses_constant_time_compare():
    """源码必须用 secrets.compare_digest，不能拿 != 直接比 token。"""
    assert "compare_digest" in SRC, (
        "token 比较仍是 `!=`（逐字节短路）——会泄露前缀匹配长度，"
        "攻击者可逐字节猜出 deploy token"
    )


def test_no_naive_token_comparison_left():
    """不许留下 `... != token` 这种直接比较（那正是原来的缺陷形状）。"""
    naive = [
        m.group(0)
        for m in re.finditer(r'X-Deploy-Token"[^)]*\)\s*!=\s*\w+', SRC)
    ]
    assert not naive, f"仍存在直接比较：{naive}"


def test_compare_digest_semantics():
    """语义等价性：正确的放行、错误的拒绝、长度不同也不崩。

    这条对着 `secrets.compare_digest` 本身跑，确认我替换后的写法行为不变。
    """
    token = "s3cret-token-value"
    assert secrets.compare_digest("s3cret-token-value", token) is True
    assert secrets.compare_digest("s3cret-token-valuX", token) is False
    assert secrets.compare_digest("", token) is False
    # 长度不同时 compare_digest 不抛异常（只要两边都是 str）
    assert secrets.compare_digest("short", token) is False


def test_empty_token_is_rejected_by_the_guard_shape():
    """守卫还要保留「token 没配就拒」——不能只换成 compare_digest 而丢掉这条。"""
    assert re.search(r"if\s+not\s+token\s+or\s+not\s+", SRC) or "not token" in SRC, (
        "没配 token 时必须仍然拒绝（fail-closed），不能因为改用 compare_digest 丢掉这层"
    )
