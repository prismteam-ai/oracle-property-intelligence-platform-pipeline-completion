import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  evidenceEnvelopeSchema,
  namedEvidenceToolDefinitions,
  type EvidenceEnvelope,
} from './schemas.js';
import {
  executeBoundedNamedEvidence,
  toMcpToolError,
  type NamedEvidenceService,
} from './service.js';

const SERVER_INSTRUCTIONS = [
  'This is the SQL-free Oracle named-evidence MCP.',
  'Every tool after get_dataset_info is bound to one immutable releaseId.',
  'Results preserve support, unknown, limitation, coverage, provenance, and timing fields.',
  'The Elephant caller-SQL compatibility executor is separately classified blocked and is not exposed here.',
  'Do not claim queryProperties compatibility unless the independent ORA-069 certification exists.',
].join(' ');

function successfulToolResult(result: EvidenceEnvelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function failedToolResult(error: unknown) {
  const redacted = toMcpToolError(error);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(redacted) }],
    isError: true as const,
  };
}

export function createNamedEvidenceMcpServer(service: NamedEvidenceService): McpServer {
  const server = new McpServer(
    { name: 'oracle-named-evidence', version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const definition of namedEvidenceToolDefinitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: evidenceEnvelopeSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: {
          'oracle/surface': 'named-evidence',
          'oracle/sqlAuthority': 'absent',
          'oracle/elephantCompatibility': 'blocked-uncertified-separate-surface',
        },
      },
      async (input) => {
        try {
          return successfulToolResult(
            await executeBoundedNamedEvidence(service, {
              tool: definition.name,
              input,
            }),
          );
        } catch (error) {
          return failedToolResult(error);
        }
      },
    );
  }

  return server;
}
