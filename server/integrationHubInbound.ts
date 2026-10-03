/**
 * Integration Hub — the inbound webhook edge (plain Express, raw body).
 *
 * A sender's signature covers the bytes it sent, so this route reads them raw and verifies before
 * anything is parsed. It is mounted BEFORE the global JSON body parser (`registerApi`'s
 * `express.json()`). The connector in the path decides the tenant; the request never does. Every
 * refusal is a named code; every acceptance is a 202 with the stable event id the sender can use
 * to de-duplicate its own retries.
 */
import type { Express, Request, Response } from "express";
import express from "express";
import { getDb } from "./db";
import { acceptInboundEvent } from "./integrationHubService";

export const INBOUND_ROUTE = "/api/integration-hub/inbound/:connectorRef";
/** The edge's own ceiling; a connector's maxPayloadBytes is checked inside and is usually lower. */
export const INBOUND_EDGE_LIMIT = "4mb";

const header = (req: Request, name: string): string | null => { const v = req.headers[name]; return Array.isArray(v) ? v[0] ?? null : v ?? null; };

export async function handleInbound(req: Request, res: Response, now: Date = new Date()): Promise<void> {
  const db = await getDb();
  if (!db) { res.status(503).json({ code: "unavailable", reason: "database unavailable" }); return; }
  const raw = req.body;
  const body = Buffer.isBuffer(raw) ? raw.toString("utf8") : typeof raw === "string" ? raw : "";
  const result = await acceptInboundEvent(db, {
    connectorRef: String(req.params.connectorRef ?? "").slice(0, 64),
    headers: {
      signature: header(req, "x-leaseos-signature"), timestamp: header(req, "x-leaseos-timestamp"), apiKey: header(req, "x-integration-key") ?? header(req, "x-api-key"),
      contentType: header(req, "content-type"), schemaVersion: header(req, "x-leaseos-schema-version"), eventType: header(req, "x-leaseos-event"),
      idempotencyKey: header(req, "x-idempotency-key"), correlationId: header(req, "x-correlation-id"), contentLength: Number(header(req, "content-length") ?? 0) || null,
    },
    body, now,
  });
  res.status(result.status).json(result.body);
}

export function registerIntegrationHubInboundRoute(app: Express): void {
  app.post(INBOUND_ROUTE, express.raw({ type: () => true, limit: INBOUND_EDGE_LIMIT }), (req, res) => {
    handleInbound(req, res).catch(e => {
      // Never the error text: it can carry a hostname or a header. The code is enough for the sender; the row and the log carry the rest.
      console.error("[integration-hub] inbound failed", e instanceof Error ? e.message : e);
      if (!res.headersSent) res.status(500).json({ code: "internal", reason: "inbound processing failed" });
    });
  });
}
