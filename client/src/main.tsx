import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { installPauseEngine } from './pause/pauseEngine';

// Before anything schedules a timer, so the settings menu can pause them all.
installPauseEngine();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
