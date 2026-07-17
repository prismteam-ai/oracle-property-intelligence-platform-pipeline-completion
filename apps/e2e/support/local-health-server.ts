import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = 4174;

const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-oracle-fixture', 'TEST_ONLY_DETERMINISTIC_FIXTURE');
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200);
    response.end(
      JSON.stringify({
        service: 'api',
        status: 'ready',
        readiness: 'test_fixture',
        dataQueryPerformed: false,
        productionReleaseRequired: true,
        fixture: 'TEST_ONLY_DETERMINISTIC_FIXTURE',
      }),
    );
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
});

server.listen(port, host);

function close(): void {
  server.close(() => process.exit(0));
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
