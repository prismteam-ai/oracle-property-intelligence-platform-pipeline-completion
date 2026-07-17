import { Route, Routes } from 'react-router-dom';

import { OracleProvider } from './app-context.js';
import { AppShell } from './app-shell.js';
import {
  AgentPage,
  ArchitecturePage,
  ArtifactsPage,
  CapabilitiesPage,
  CoveragePage,
  DictionaryPage,
  EvidencePage,
  inquiries,
  InquiryPage,
  McpPage,
  NotFoundPage,
  OverviewPage,
  PipelinePage,
  PropertiesPage,
  PropertyDetailPage,
  RankingsPage,
} from './pages.js';
import type { ApiClient } from './types.js';

export function App({
  client,
  testFixtureLabel,
}: Readonly<{ client: ApiClient; testFixtureLabel?: string }>) {
  return (
    <OracleProvider
      client={client}
      {...(testFixtureLabel === undefined ? {} : { testFixtureLabel })}
    >
      <AppShell>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/pipeline" element={<PipelinePage />} />
          <Route path="/coverage" element={<CoveragePage />} />
          <Route path="/properties" element={<PropertiesPage />} />
          <Route path="/properties/:propertyId" element={<PropertyDetailPage />} />
          {inquiries.map((inquiry) => (
            <Route
              key={inquiry.slug}
              path={`/inquiries/${inquiry.slug}`}
              element={<InquiryPage inquiry={inquiry} />}
            />
          ))}
          <Route path="/rankings" element={<RankingsPage />} />
          <Route path="/agent" element={<AgentPage />} />
          <Route path="/artifacts" element={<ArtifactsPage />} />
          <Route path="/dictionary" element={<DictionaryPage />} />
          <Route path="/mcp" element={<McpPage />} />
          <Route path="/capabilities" element={<CapabilitiesPage />} />
          <Route path="/evidence" element={<EvidencePage />} />
          <Route path="/about/architecture" element={<ArchitecturePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AppShell>
    </OracleProvider>
  );
}
