import React from 'react';
import { createRoot } from 'react-dom/client';
import './theme/tokens.generated.css';
import './theme/app.css';
import './shell/shell.css';
import './shell/visual.css';
import { Shell } from './shell/Shell';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);
