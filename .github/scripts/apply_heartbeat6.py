#!/usr/bin/env python3
"""心跳补丁 6：不再暗示"你上一条没回就别再发"。

她的意思是：TA 主动说了最后一句、她没回时，TA 仍然可以继续发消息，不要一刀切。
这里只改醒来提示里的那一句：没回时别重复同样的话，但有新的、想说的事可以接着说。

在仓库根目录运行，可重复运行；锚点找不到或不唯一就直接报错退出。
"""
import sys
from pathlib import Path

GATE = Path('worker/amsg/src/triggerGate.ts')

OLD = "  '拿不准就不说。你上一条主动发的她还没回，就别再发；刚聊完又没有新东西，也别硬找话说。',\n"
NEW = ("  '拿不准就不说。你上一条主动发的她还没回的话，别重复同样的话；"
       "如果有新的、想说的事，可以接着说。刚聊完又没有新东西，就别硬找话说。',\n")


def main():
    t = GATE.read_text(encoding='utf-8')
    if '可以接着说' in t:
        print('triggerGate.ts：补丁6已打过，跳过')
        return
    if t.count(OLD) != 1:
        sys.exit(f'[补丁6失败] 醒来提示那一句：锚点出现 {t.count(OLD)} 次（应为 1 次）')
    GATE.write_text(t.replace(OLD, NEW, 1), encoding='utf-8')
    print('triggerGate.ts：已打补丁6')


if __name__ == '__main__':
    main()
