import {
  Activity,
  Archive,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  ChevronDown,
  CircleGauge,
  DatabaseZap,
  FileKey2,
  GitCompareArrows,
  Home,
  Info,
  Map,
  Moon,
  Network,
  PanelLeftClose,
  Search,
  ServerCog,
  TerminalSquare,
  Sun,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { useOracle } from './app-context.js';

const navigation = [
  { to: '/', label: 'Overview', icon: Home, end: true },
  { to: '/pipeline', label: 'Pipeline', icon: Activity },
  { to: '/coverage', label: 'Coverage', icon: CircleGauge },
  { to: '/properties', label: 'Properties', icon: Search },
  { to: '/inquiries/roof-age', label: 'Roof age', icon: Building2 },
  { to: '/inquiries/water-candidates', label: 'Water candidates', icon: Map },
  { to: '/inquiries/ownership-age', label: 'Ownership age', icon: FileKey2 },
  { to: '/inquiries/regional-owner', label: 'Regional owner', icon: Network },
  { to: '/inquiries/transit-walkability', label: 'Transit walkability', icon: GitCompareArrows },
  { to: '/inquiries/starbucks-walkability', label: 'Starbucks walkability', icon: Map },
  { to: '/rankings', label: 'Combined ranking', icon: Boxes },
  { to: '/agent', label: 'Agent trace', icon: Bot },
  { to: '/query-console', label: 'Query console', icon: TerminalSquare },
  { to: '/artifacts', label: 'Artifacts', icon: Archive },
  { to: '/dictionary', label: 'Data dictionary', icon: BookOpen },
  { to: '/mcp', label: 'MCP setup', icon: ServerCog },
  { to: '/capabilities', label: 'Capabilities', icon: Info },
  { to: '/evidence', label: 'Release evidence', icon: DatabaseZap },
  { to: '/about/architecture', label: 'Architecture', icon: PanelLeftClose },
] as const;

const bottomNavigation = navigation.filter(({ to }) =>
  ['/', '/properties', '/inquiries/roof-age', '/agent', '/artifacts'].includes(to),
);

function NavigationLinks() {
  return (
    <>
      {navigation.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
        >
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
    </>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`Use ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  );
}

function RouteFocus() {
  const location = useLocation();
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('#main-content h1');
    heading?.focus();
  }, [location.pathname]);
  return null;
}

function ReleaseIdentityStatus() {
  const { release } = useOracle();
  if (release.status !== 'success') return null;

  const { releaseId } = release.data;
  return (
    <div
      className="shell-release-status"
      role="status"
      aria-label={`Immutable dataset release identity: ${releaseId}`}
    >
      <DatabaseZap aria-hidden="true" />
      <span>Immutable verified release</span>
      <strong data-release-id={releaseId} data-testid="release-id">
        {releaseId}
      </strong>
    </div>
  );
}

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Oracle property intelligence home">
          <span className="brand-mark" aria-hidden="true">
            <DatabaseZap />
          </span>
          <span>
            <strong>Oracle</strong>
            <small>Property intelligence</small>
          </span>
        </a>
        <p className="nav-section-label">Evaluator</p>
        <nav className="side-navigation" aria-label="Primary navigation">
          <NavigationLinks />
        </nav>
        <div className="sidebar-foot">
          <span className="runtime-dot" aria-hidden="true" />
          <span>Fail-closed release mode</span>
          <ThemeToggle />
        </div>
      </aside>

      <div className="content-column">
        <header className="mobile-header">
          <a className="brand" href="/" aria-label="Oracle property intelligence home">
            <span className="brand-mark" aria-hidden="true">
              <DatabaseZap />
            </span>
            <span>
              <strong>Oracle</strong>
              <small>Santa Clara County</small>
            </span>
          </a>
          <div className="mobile-header-actions">
            <ThemeToggle />
            <details className="more-menu">
              <summary aria-label="Open all navigation">
                <ChevronDown aria-hidden="true" />
                <span>More</span>
              </summary>
              <nav aria-label="All destinations">
                <NavigationLinks />
              </nav>
            </details>
          </div>
        </header>
        <ReleaseIdentityStatus />
        <RouteFocus />
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
        <footer className="product-footer">
          <span>Oracle evaluator</span>
          <span>Santa Clara County, California</span>
          <span>No synthetic production rows</span>
        </footer>
      </div>

      <nav className="bottom-navigation" aria-label="Mobile primary navigation">
        {bottomNavigation.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            <Icon aria-hidden="true" />
            <span>{label === 'Roof age' ? 'Inquiries' : label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export { navigation };
