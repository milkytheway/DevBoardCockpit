import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// 每个测试后卸载已渲染的组件——否则同一文件里的多次 render 会叠加，
// getByTestId 会找到多个同名的元素。
afterEach(() => {
  cleanup();
});

/**
 * 测试环境缺 xterm 与我们组件需要的浏览器 API：
 *
 * - `window.matchMedia` —— xterm 用来判断 Unicode 宽度支持
 * - `HTMLCanvasElement.prototype.getContext` —— xterm 的渲染器；DOM 实现不提供 canvas
 * - `ResizeObserver` —— 我们用它监听终端容器尺寸变化
 *
 * 这里的 canvas 与 ResizeObserver 都是**空实现**——
 * 测试验的是组件的挂载与事件接线，不是终端的像素渲染。
 * 终端真实渲染由《真机验收清单》负责。
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* jsdom 不布局，尺寸变化由测试显式触发 */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  } as unknown as typeof ResizeObserver;
}
