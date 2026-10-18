#!/usr/bin/env python3
"""登记「醒来记录」App：照着「生图」App 的登记行复制一份。

要改两个文件（都只加几行，不动 types.ts）：
  constants.tsx            桌面图标 + 图标表 + 图标导入
  components/PhoneShell.tsx  按需加载 + ID→组件 + 渲染分支
做法：找到「生图」那几行（每种必须恰好 1 行），在它后面照样复制一行；任何一处找不到或不唯一就直接报错退出，
不会写出改到一半的文件。可重复运行（已登记过就跳过）。
"""
import re
import sys
from pathlib import Path

CONST = Path('constants.tsx')
SHELL = Path('components/PhoneShell.tsx')


def find_one(lines, pat, label):
    idx = [i for i, l in enumerate(lines) if re.search(pat, l)]
    if len(idx) != 1:
        sys.exit(f'[登记失败] {label}：匹配到 {len(idx)} 行（应为 1 行）')
    return idx[0]


def clone(l):
    return (l.replace('IMAGEGEN_APP_ID', 'WAKELOG_APP_ID')
             .replace('ImageGenApp', 'WakeLogApp')
             .replace('imageGenAppId', 'wakeLogAppId'))


def indent_of(l):
    return l[: len(l) - len(l.lstrip())]


def patch_shell():
    t = SHELL.read_text(encoding='utf-8')
    if 'WAKELOG_APP_ID' in t:
        print('PhoneShell.tsx：已登记，跳过')
        return
    lines = t.split('\n')
    pats = [
        (r"^import \{ IMAGEGEN_APP_ID \} from '\.\./utils/imageGenAppId';", 'ID 导入'),
        (r"^const ImageGenApp = lazyApp\(", '按需加载'),
        (r"^\s*\[IMAGEGEN_APP_ID\]:\s*ImageGenApp,", 'ID→组件'),
        (r"case IMAGEGEN_APP_ID:\s*return <ImageGenApp />", '渲染分支'),
    ]
    # 先全部定位（从后往前插入，行号不乱）
    found = sorted(((find_one(lines, p, lab), lab) for p, lab in pats), reverse=True)
    for i, lab in found:
        if not lines[i].rstrip().endswith((';', ',')):
            sys.exit(f'[登记失败] {lab}：那一行不是以 ; 或 , 结尾，可能是多行写法，不敛自动复制')
        lines.insert(i + 1, clone(lines[i]))
    SHELL.write_text('\n'.join(lines), encoding='utf-8')
    print('PhoneShell.tsx：已登记')


def patch_const():
    t = CONST.read_text(encoding='utf-8')
    if 'WAKELOG_APP_ID' in t:
        print('constants.tsx：已登记，跳过')
        return
    lines = t.split('\n')
    i_import = find_one(lines, r"^import \{ IMAGEGEN_APP_ID \} from '\./utils/imageGenAppId';", 'ID 导入')
    i_icons = find_one(lines, r"^\s*ImageGen:\s*\(", '图标表')
    i_app = find_one(lines, r"IMAGEGEN_APP_ID,\s*name:", '桌面图标')
    i_phos = find_one(lines, r"^\} from '@phosphor-icons/react';", '图标库导入')
    if not lines[i_icons].rstrip().endswith(','):
        sys.exit('[登记失败] 图标表：「生图」那一项不是单行写法，不敛自动复制')
    if not lines[i_app].rstrip().endswith('},'):
        sys.exit('[登记失败] 桌面图标：「生图」那一项不是单行写法，不敛自动复制')
    has_pulse = any(re.search(r'\bPulse\b', l) for l in lines[: i_phos + 1])
    inserts = [
        (i_app + 1, indent_of(lines[i_app]) + "{ id: WAKELOG_APP_ID, name: '醒来记录', icon: 'WakeLog', color: 'indigo' },"),
        (i_icons + 1, indent_of(lines[i_icons]) + 'WakeLog: ({ className }) => <Pulse className={className} weight="regular" />,'),
        (i_import + 1, "import { WAKELOG_APP_ID } from './utils/wakeLogAppId';"),
    ]
    if not has_pulse:
        inserts.append((i_phos, '  Pulse,'))
    for pos, text in sorted(inserts, reverse=True):
        lines.insert(pos, text)
    CONST.write_text('\n'.join(lines), encoding='utf-8')
    print('constants.tsx：已登记')


if __name__ == '__main__':
    patch_shell()
    patch_const()
