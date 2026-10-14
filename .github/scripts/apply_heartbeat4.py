#!/usr/bin/env python3
"""心跳补丁 4：睡没睡由角色自己确认。

补丁 3 里服务端直接断言"他多半在睡觉"。服务端只是用"深夜没手机动静 / 睡眠专注开着"在猜，会猜错。
改成：只说"记录显示他可能在睡觉，这只是推测"，让角色用自己查手机的工具确认，再决定要不要发消息。

在仓库根目录运行，可重复运行；锚点找不到或不唯一就直接报错退出。
"""
import sys
from pathlib import Path

GATE = Path('worker/amsg/src/triggerGate.ts')


def main():
    t = GATE.read_text(encoding='utf-8')
    if '这只是推测' in t:
        print('triggerGate.ts：补丁4已打过，跳过')
        return
    old = "      '他现在多半在睡觉（深夜、手机也没动静，或者开着睡眠专注）。别发消息吵醒他，除非真的有急事。'\n"
    new = ("      '服务这边的记录显示他可能在睡觉（深夜没有手机动静，或睡眠专注开着），这只是推测，"
           "他到底醒着还是睡着，你可以用自己查手机的工具确认。'\n"
           "        + '如果他像是睡着了，别发消息吵醒他，除非真的有急事。'\n")
    if t.count(old) != 1:
        sys.exit(f'[补丁4失败] 睡着提示：锚点出现 {t.count(old)} 次（应为 1 次）')
    GATE.write_text(t.replace(old, new, 1), encoding='utf-8')
    print('triggerGate.ts：已打补丁4')


if __name__ == '__main__':
    main()
