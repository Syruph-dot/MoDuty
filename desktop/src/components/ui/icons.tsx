import type { ReactNode, SVGProps } from "react";

/**
 * 内联 SVG 图标集。
 *
 * 为什么不用 emoji / 字符字形（⚙ 🔍 ⭳ ×）：它们的呈现取决于系统 emoji 字体，
 * 在部分平台会变成彩色 emoji（尺寸、颜色、基线都不可控），也无法跟随 currentColor 主题化。
 * 这里统一用 `stroke: currentColor` 的线性图标，尺寸与颜色由 CSS 决定。
 */

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** 边长（px），默认 18 */
  size?: number;
}

function Icon({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 齿轮：编辑 System Prompt（人格） */
export function IconGear(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 14.6a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1.04-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.47-1.04 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 .97-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47.97H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.03Z" />
    </Icon>
  );
}

/** 放大镜：会话内检索 */
export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m19.6 19.6-3.5-3.5" />
    </Icon>
  );
}

/** 下载箭头：导出会话记录 */
export function IconDownload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5v11" />
      <path d="m7.2 10.5 4.8 4.8 4.8-4.8" />
      <path d="M4.5 20h15" />
    </Icon>
  );
}

/** 叉：关闭窗口 */
export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.2 6.2 17.8 17.8" />
      <path d="M17.8 6.2 6.2 17.8" />
    </Icon>
  );
}

/** 归档柜：归档库 */
/** 思考过程：气泡里三个点（不用 emoji：字形大小/基线/颜色都不可控） */
export function IconThought({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.2 2.8h9.6a1.4 1.4 0 0 1 1.4 1.4v5a1.4 1.4 0 0 1-1.4 1.4H8.2l-2.4 2.1V10.6H3.2a1.4 1.4 0 0 1-1.4-1.4v-5a1.4 1.4 0 0 1 1.4-1.4Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="5.4" cy="6.7" r="0.85" fill="currentColor" />
      <circle cx="8" cy="6.7" r="0.85" fill="currentColor" />
      <circle cx="10.6" cy="6.7" r="0.85" fill="currentColor" />
    </svg>
  );
}

export function IconArchive(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.6" y="4.2" width="16.8" height="4.6" rx="1.2" />
      <path d="M5.4 8.8V19a1.2 1.2 0 0 0 1.2 1.2h10.8a1.2 1.2 0 0 0 1.2-1.2V8.8" />
      <path d="M10 12.6h4" />
    </Icon>
  );
}

/** 分组视图：带行文的框（▤） */
export function IconLayoutList(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4.4" width="16" height="15.2" rx="2" />
      <path d="M7.6 9.4h8.8" />
      <path d="M7.6 12.4h8.8" />
      <path d="M7.6 15.4h5.2" />
    </Icon>
  );
}

/** 桌面视图：四宫格（▦） */
export function IconLayoutGrid(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4.4" width="6.6" height="6.6" rx="1.3" />
      <rect x="13.4" y="4.4" width="6.6" height="6.6" rx="1.3" />
      <rect x="4" y="13" width="6.6" height="6.6" rx="1.3" />
      <rect x="13.4" y="13" width="6.6" height="6.6" rx="1.3" />
    </Icon>
  );
}

/** 地球：浏览器标签 */
export function IconBrowser(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.6c2.3 2.7 2.3 14.1 0 16.8-2.3-2.7-2.3-14.1 0-16.8Z" />
    </Icon>
  );
}

/** 机器人头：Agent 标签 */
export function IconAgent(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.6" y="8.2" width="14.8" height="10.6" rx="3.2" />
      <path d="M12 8.2V4.6" />
      <path d="M9.4 13.2h.02" />
      <path d="M14.6 13.2h.02" />
      <path d="M9.8 16h4.4" />
    </Icon>
  );
}

/** 返回箭头：返回上一级 */
export function IconBack(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 4.8 7.8 12l7.2 7.2" />
    </Icon>
  );
}

/** 左右箭头：标签条滚动 */
export function IconChevronLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 5.5 16 12l-6.5 6.5" />
    </Icon>
  );
}
