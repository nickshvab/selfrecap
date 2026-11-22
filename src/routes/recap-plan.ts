/**
 * GET /voices/:voice/recap-plan[?draft=1|0][&cut=<uuid>]
 *
 * Read-only. Everything a session needs for /remember in one call: the live
 * session, the recap stack, the next recap number and body path, the sentinel
 * values to copy, the headroom left for the body, a before_timestamp for
 * find-cut-point, the restart command and whether self-restart is available.
 * `npx tsx scripts/recap.ts <voice> --plan` prints it.
 *
 * `draft=1` adds the draft for the next recap (its size, or an estimate) and
 * counts a written draft in headroom; `draft=0` leaves it out. Without the
 * parameter the server's own setting decides (config draft.enabled, or
 * SELFRECAP_DRAFT in the server's environment). recap.ts always says which,
 * by its own setting, so the plan it prints matches what it will do. `cut`
 * is the pending cut recap.ts holds: the draft's estimate runs up to it
 * (without it, up to the pending cut in the server's own log folder, if any).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { UnknownVoiceError, draftGate } from "../config.js";
import { buildRecapPlan } from "../lib/recap-plan.js";

export function registerRecapPlan(app: FastifyInstance, config: AppConfig) {
  app.get<{ Params: { voice: string }; Querystring: { draft?: string; cut?: string } }>("/voices/:voice/recap-plan", async (request, reply) => {
    const q = request.query.draft;
    const draft = q === "1" || q === "true" ? true : q === "0" || q === "false" ? false : draftGate(config).enabled;
    const cut = request.query.cut;
    if (cut !== undefined && !UUID_RE.test(cut)) {
      return reply.status(400).send({ error: "bad_cut", message: "cut must be a record uuid" });
    }
    try {
      return reply.send(buildRecapPlan(config, request.params.voice, new Date(), { draft, ...(cut ? { cut } : {}) }));
    } catch (e: any) {
      if (e instanceof UnknownVoiceError) {
        return reply.status(404).send({ error: "voice_not_found", message: e.message });
      }
      return reply.status(500).send({ error: "plan_failed", message: e.message });
    }
  });
}
