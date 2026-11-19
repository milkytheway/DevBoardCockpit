import React from 'react';
import { createRoot } from 'react-dom/client';
import './theme/tokens.generated.css';
import './theme/app.css';
import './shell/shell.css';
import './shell/visual.css';
import { Shell } from './shell/Shell';
import { pick, readStoredLocale, type Localised } from './shell/i18n';

/** The wording of the entry point, in both languages. */
const strings = {
  noRoot: { 'zh-Hans': '找不到 #root 挂载点', en: 'No #root mount point' },
} satisfies Record<string, Localised>;

const container = document.getElementById('root');
if (!container) throw new Error(pick(strings.noRoot, readStoredLocale()));

createRoot(container).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);
