import { createServer, type Server } from "node:http";

/**
 * What a real SeaweedFS fetches in the CI job (#566): `GET <issuer>/.well-known/jwks.json`, answered by the Panel's own
 * route (`handleApiRequest`), not by a file the test made. The Panel is in-process here, so this is the same
 * `Request → Response` the deployed service serves, put on the loopback port the rendered IAM config points at.
 * `hits` counts the requests the route answered 200, so a test can say SeaweedFS really read it.
 */
export type PanelJwksServer = { server: Server; hits: () => number };

export async function servePanelJwks(
  port: number,
  handleApiRequest: (request: Request) => Promise<Response | null>,
): Promise<PanelJwksServer> {
  let hits = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const response = await handleApiRequest(new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, { method: req.method }));
      if (!response) {
        res.writeHead(404).end();
        return;
      }
      if (response.status === 200 && req.url === "/.well-known/jwks.json") hits += 1;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, hits: () => hits };
}
