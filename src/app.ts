import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "ethers";
import { isHash, type MetadataStore } from "./metadata/store.js";
import { BadRequestError, type VerificationService } from "./verification/service.js";

/**
 * HTTP API. Deliberately thin: every verification decision is made by the engine.
 *
 *   GET  /api/health
 *   GET  /api/verify/:batchId[?expectedRecipient=0x...]   -> verification report (JSON)
 *   POST /api/metadata                                     -> stores metadata, returns its hash
 *   GET  /api/metadata/:hash
 */
export function createApp(
  service: VerificationService,
  store: MetadataStore,
  logError: (err: unknown) => void = (err) => console.error(err),
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  // The public verification page (plain HTML/CSS/JS in web/), served from the same origin as the
  // API so it needs no CORS setup and no build step.
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
  app.use(express.static(webDir, { index: "index.html" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/verify/:batchId", async (req, res) => {
    const expected = req.query.expectedRecipient;
    if (expected !== undefined && (typeof expected !== "string" || !isAddress(expected))) {
      throw new BadRequestError("expectedRecipient must be a valid Ethereum address");
    }
    const report = await service.verify(req.params.batchId, expected ? { expectedRecipient: expected } : {});
    res.json(report);
  });

  app.post("/api/metadata", async (req, res) => {
    const body: unknown = req.body;
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) {
      throw new BadRequestError("Body must be a non-empty JSON object");
    }
    const hash = await store.save(body);
    res.status(201).json({ hash });
  });

  app.get("/api/metadata/:hash", async (req, res) => {
    if (!isHash(req.params.hash)) throw new BadRequestError("Invalid metadata hash");
    const content = await store.get(req.params.hash);
    if (content === undefined) {
      res.status(404).json({ error: "No metadata stored for this hash" });
      return;
    }
    res.json(content);
  });

  // Express 5 forwards errors from async handlers here automatically.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequestError) {
      res.status(400).json({ error: err.message });
    } else if ((err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body is not valid JSON" });
    } else if ((err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "Request body too large" });
    } else {
      // Chain/RPC trouble is NOT a verification result: never turn it into "verified" or "not found".
      logError(err);
      res.status(502).json({ error: "Could not read the blockchain right now. No verification result was produced." });
    }
  });

  return app;
}
