import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { FOUNDATION_STATUS } from '@oracle/contracts';

import { statusCards } from './status.js';
import './styles.css';

function App() {
  return (
    <main>
      <nav aria-label="Primary navigation">
        <a className="brand" href="/" aria-label="Oracle home">
          <span className="brand-mark" aria-hidden="true">
            O
          </span>
          <span>Oracle</span>
        </a>
        <span className="nav-label">Santa Clara County · Foundation</span>
      </nav>

      <section className="hero" aria-labelledby="page-title">
        <div className="signal" aria-hidden="true">
          <span />
          Foundation online
        </div>
        <p className="kicker">Property intelligence, built on verifiable evidence</p>
        <h1 id="page-title">
          The runtime foundation is <em>ready.</em>
          <br />
          The data product is next.
        </h1>
        <p className="lede">
          A reproducible serverless base now separates the web, typed API, MCP boundary, and offline
          pipeline. This page reports only what exists today—no synthetic records and no premature
          data claims.
        </p>
        <div className="meta-row">
          <span>Node 22</span>
          <span>Typed contracts</span>
          <span>Private S3 + CloudFront</span>
        </div>
      </section>

      <section className="status-grid" aria-label="Implementation status">
        {statusCards.map((card, index) => (
          <article className="status-card" key={card.title}>
            <div className="card-index">0{index + 1}</div>
            <p className="eyebrow">{card.eyebrow}</p>
            <h2>{card.title}</h2>
            <span className="state">Not implemented yet</span>
            <p>{card.detail}</p>
          </article>
        ))}
      </section>

      <footer>
        <span>Operation</span>
        <code>{FOUNDATION_STATUS.operation}</code>
        <span className="footer-state">foundation_only</span>
      </footer>
    </main>
  );
}

const rootElement = document.querySelector('#root');
if (rootElement === null) throw new Error('Root element is missing');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
