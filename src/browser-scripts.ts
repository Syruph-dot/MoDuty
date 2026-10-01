/**
 * 注入页面的脚本源码（两个传输后端共用）。
 *
 * 为什么集中在这里：这些脚本既要给 Playwright 的 `page.evaluate` 用，也要给
 * 自建 CDP 客户端的 `Runtime.evaluate` 用。共用同一份源码，才能保证换传输后
 * `browse_observe` 的快照结构、ref 编号、`dom` 的 inspect 结果完全一致。
 *
 * 注意：快照脚本以**字符串**形式注入，不是函数。原因是原实现里用 esbuild 打包时，
 * 模块内的函数会被注入 `__name` helper，浏览器端无法解析；字符串形式没有这个依赖。
 */

/** 快照脚本：收集可交互/文本元素，逐个生成唯一 CSS selector */
export function snapshotScript(maxNodes: number): string {
  return `(() => {
      const max = ${maxNodes};
      const out = [];
      const uniqueId = (el) => {
        if (el.id) return '#' + CSS.escape(el.id);
        return '';
      };
      const cssPath = (el) => {
        const uid = uniqueId(el);
        if (uid) return uid;
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 6) {
          let part;
          if (node.id) {
            part = node.tagName.toLowerCase() + '#' + CSS.escape(node.id);
            parts.unshift(part);
            break;
          }
          const parent = node.parentElement;
          if (parent) {
            const children = Array.from(parent.children);
            const index = children.indexOf(node);
            part = index >= 0 ? node.tagName.toLowerCase() + ':nth-child(' + (index + 1) + ')' : node.tagName.toLowerCase();
          } else {
            part = node.tagName.toLowerCase();
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(' > ');
      };
      const roleOf = (tag) => {
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'input') return 'textbox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'listbox';
        if (tag === 'img') return 'img';
        if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading';
        return 'text';
      };
      const walk = (root) => {
        if (out.length >= max) return;
        const nodes = root.querySelectorAll('a,button,input,textarea,select,label,img,[role],[tabindex],h1,h2,h3,li,p,span,[contenteditable]');
        for (const el of Array.from(nodes).slice(0, max)) {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || roleOf(tag);
          const aria = el.getAttribute('aria-label');
          const placeholder = el.getAttribute('placeholder');
          const title = el.getAttribute('title');
          const text = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
          const value = el.value ? ' value="' + el.value.slice(0, 40) + '"' : '';
          const name = aria || placeholder || title || text;
          const visible = !!(el.offsetParent || el.getClientRects().length > 0) && name.length > 0;
          if (!visible) continue;
          out.push({ tag: tag, role: role, name: name, sel: cssPath(el), visible: true, value: value });
          if (out.length >= max) break;
        }
      };
      walk(document.body || document.documentElement);
      return out;
    })()`;
}

/** 单个元素的检查逻辑（`dom` 的 inspect 动作） */
export function inspectElementFn(el: Element): Record<string, unknown> {
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName,
    text: (el.textContent ?? "").trim().slice(0, 200),
    attrs: Array.from(el.attributes).slice(0, 20).map((attr) => `${attr.name}=${attr.value.slice(0, 50)}`),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
}

/** 把 inspectElementFn 包成可直接注入的表达式（CDP 走这条；Playwright 直接传函数） */
export function inspectScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    return (${inspectElementFn.toString()})(el);
  })()`;
}

/**
 * 元素中心坐标（供坐标注入使用）。
 * 会先 `scrollIntoView`：Playwright 的 `click` 自带滚动，CDP 路径要自己补，
 * 否则元素在视口外时坐标是负值、点击落在页面外。
 */
export function elementCenterScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not-found' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, reason: 'not-visible' };
    return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}

/** 元素数量（用于严格模式近似判定：匹配多个时 Playwright 会报错） */
export function selectorCountScript(selector: string): string {
  return `document.querySelectorAll(${JSON.stringify(selector)}).length`;
}

/**
 * URL 等待脚本：用 location.href 判断，避免依赖 CDP 的导航事件。
 * 传入的是已转义的正则源码（与 Playwright 分支保持同一套转义）。
 */
export function urlMatchedScript(regexSource: string): string {
  return `new RegExp(${JSON.stringify(regexSource)}).test(location.href)`;
}

/** 文本等待脚本（Playwright 用 `text=` 语义；CDP 用 innerText 包含判断近似） */
export function bodyTextContainsScript(text: string): string {
  return `(document.body ? document.body.innerText : '').includes(${JSON.stringify(text)})`;
}

/** 选择器存在性脚本 */
export function selectorExistsScript(selector: string): string {
  return `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
}

/** 页面元信息脚本 */
export const PAGE_META_SCRIPT = "({ url: location.href, title: document.title })";

/**
 * 填值脚本（React 等受控组件兼容）。
 *
 * 直接 `el.value = text` 会被框架的 value setter 抹掉，必须用原型上的原生 setter
 * 写值再补 `input` / `change` 事件，框架才会感知到变化。
 */
export function fillScript(selector: string, text: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not-found' };
    el.focus();
    if (el.isContentEditable) {
      el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return { ok: true, mode: 'contenteditable' };
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, ${JSON.stringify(text)});
    else el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, mode: 'value', value: el.value };
  })()`;
}

/** 焦点脚本 */
export function focusScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return true;
  })()`;
}
