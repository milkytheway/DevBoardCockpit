import '@testing-library/jest-dom/vitest';

/**
 * jsdom 缺 xterm 与我们组件需要的浏览器 API：
 *
 * - `window.matchMedia` —— xterm 用来判断 Unicode 宽度支持
 * - `HTMLCanvasElement.prototype.getContext` —— xterm 的渲染器；jsdom 不实现 canvas
 * - `ResizeObserver` —— 我们用它监听终端容器尺寸变化
 *
 * jsdom 里的 canvas 与 ResizeObserver 都是**空实现**——
 * 测试验的是组件的挂载与事件接线，不是终端的像素渲染。
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
