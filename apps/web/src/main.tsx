import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { createProductionApiClient } from './api.js';
import { App } from './app.js';
import './styles.css';

const apiBaseUrl = import.meta.env.VITE_ORACLE_API_BASE_URL ?? window.location.origin;
const client = createProductionApiClient(apiBaseUrl);

const rootElement = document.querySelector('#root');
if (rootElement === null) throw new Error('Root element is missing');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App client={client} />
    </BrowserRouter>
  </StrictMode>,
);
