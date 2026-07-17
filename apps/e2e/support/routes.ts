export type EvaluatorRoute = Readonly<{
  key: string;
  path: string;
  heading: RegExp;
}>;

export const evaluatorRoutes = Object.freeze([
  { key: 'overview', path: '/', heading: /Property intelligence with evidence/i },
  { key: 'pipeline', path: '/pipeline', heading: /Run history and source constraints/i },
  { key: 'coverage', path: '/coverage', heading: /What the release can.*cannot.*support/i },
  { key: 'properties', path: '/properties', heading: /Search canonical property identities/i },
  { key: 'roof-age', path: '/inquiries/roof-age', heading: /roof.*(?:age|15 years)/i },
  {
    key: 'water-candidates',
    path: '/inquiries/water-candidates',
    heading: /Potential water-view candidates/i,
  },
  {
    key: 'ownership-age',
    path: '/inquiries/ownership-age',
    heading: /No ownership exchange in more than 10 years/i,
  },
  {
    key: 'regional-owner',
    path: '/inquiries/regional-owner',
    heading: /Properties with regional owners/i,
  },
  {
    key: 'transit-walkability',
    path: '/inquiries/transit-walkability',
    heading: /Walking distance to public transportation/i,
  },
  {
    key: 'starbucks-walkability',
    path: '/inquiries/starbucks-walkability',
    heading: /Walking distance to Starbucks/i,
  },
  { key: 'rankings', path: '/rankings', heading: /Combined review candidates/i },
  { key: 'agent', path: '/agent', heading: /Ask the release.*inspect every tool call/i },
  { key: 'artifacts', path: '/artifacts', heading: /Release artifacts and content identifiers/i },
  {
    key: 'dictionary',
    path: '/dictionary',
    heading: /Fields, definitions, and publication boundaries/i,
  },
  {
    key: 'capabilities',
    path: '/capabilities',
    heading: /A claim vocabulary designed to resist overstatement/i,
  },
  { key: 'mcp', path: '/mcp', heading: /Connect to the SQL-free named evidence surface/i },
  { key: 'evidence', path: '/evidence', heading: /One immutable receipt, without self-scoring/i },
  {
    key: 'architecture',
    path: '/about/architecture',
    heading: /Immutable data, replaceable compute/i,
  },
] satisfies readonly EvaluatorRoute[]);

export const inquiryRoutes = evaluatorRoutes.filter(({ path }) => path.startsWith('/inquiries/'));

export const deepLinkRoutes = evaluatorRoutes.filter(({ path }) => path !== '/');
