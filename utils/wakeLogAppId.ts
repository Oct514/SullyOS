import { AppID } from '../types';

// 「醒来记录」App 的 ID。和生图 App 一样，刻意不去改 types.ts 里的 AppID 枚举
// （那个文件太大、合并作者更新时容易冲突），运行时它就是个字符串，桌面图标 / 打开 / 渲染都认它。
export const WAKELOG_APP_ID = 'WakeLog' as unknown as AppID;
