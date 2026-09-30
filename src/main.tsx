import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';

// 注意：StrictMode 在开发模式下会双重执行副作用。
// SimClient 在 ref 中惰性创建（effect 之外），因此不会构造两个 Worker；
// 订阅 effect 的清理函数会注销第一个监听器，无副作用泄漏。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
