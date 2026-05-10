/**
 * REST API for Admin Panel: automations scenarios, versions, test-send, event-log.
 *
 * @module api/admin/automations-routes
 */

import express, { type Request, type Response } from "express";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import { ScenarioAdminService } from "../../modules/automations/admin/scenario-admin.service.js";
import { ScenarioConfigSchema } from "../../modules/automations/schemas/scenario-config.schema.js";
import type { ScenarioConfig } from "../../modules/automations/schemas/scenario-config.schema.js";
import AutomationEventLog from "../../entities/automations/AutomationEventLog.js";
import OfferInstance from "../../entities/automations/OfferInstance.js";

function paramStr(p: string | string[] | undefined): string {
  return (Array.isArray(p) ? p[0] : p) ?? "";
}

export function createAutomationsRouter(deps: { getBot?: () => { api: { sendMessage: (chatId: number, text: string, extra?: object) => Promise<unknown> } } | null }) {
  const router = express.Router();

  router.get("/scenarios", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const service = new ScenarioAdminService(ds);
      const category = req.query.category as string | undefined;
      const enabled = req.query.enabled === "true" ? true : req.query.enabled === "false" ? false : undefined;
      const list = await service.listScenarios({ category: category as any, enabled });
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/scenarios/:key", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const service = new ScenarioAdminService(ds);
      const s = await service.getScenario(paramStr(req.params.key));
      if (!s) return res.status(404).json({ error: "Not found" });
      res.json(s);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/scenarios", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const service = new ScenarioAdminService(ds);
      const created = await service.createScenario(req.body);
      res.status(201).json(created);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.put("/scenarios/:key", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const service = new ScenarioAdminService(ds);
      const updated = await service.updateScenario(paramStr(req.params.key), req.body);
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.delete("/scenarios/:key", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const service = new ScenarioAdminService(ds);
      await service.deleteScenario(paramStr(req.params.key));
      res.status(204).send();
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/scenarios/:key/versions", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const service = new ScenarioAdminService(ds);
      const list = await service.listVersions(paramStr(req.params.key));
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post("/scenarios/:key/versions", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const service = new ScenarioAdminService(ds);
      const config = ScenarioConfigSchema.parse(req.body.config);
      const created = await service.createVersion({
        scenarioKey: paramStr(req.params.key),
        config: config as ScenarioConfig,
        status: req.body.status,
      });
      res.status(201).json(created);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.post("/scenarios/:key/versions/:id/publish", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const service = new ScenarioAdminService(ds);
      const versionId = parseInt(paramStr(req.params.id), 10);
      const publishedBy = req.body.publishedBy != null ? parseInt(String(req.body.publishedBy), 10) : undefined;
      const published = await service.publishVersion(paramStr(req.params.key), versionId, publishedBy);
      res.json(published);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.post("/scenarios/:key/test-send", async (req: Request, res: Response) => {
    try {
      const userId = req.body.userId ?? req.body.telegramId;
      if (userId == null) return res.status(400).json({ error: "userId or telegramId required" });
      const ds = await getAppDataSource();
      const version = await new ScenarioAdminService(ds).getPublishedVersion(paramStr(req.params.key));
      if (!version?.config) return res.status(404).json({ error: "No published version" });
      const config = version.config as ScenarioConfig;
      const templateKey = config.steps?.[0]?.templateKey;
      const template = templateKey ? config.templates?.[templateKey] : null;
      const lang = (req.body.lang as "ru" | "en") ?? "ru";
      const variables: Record<string, string | number> = { "user.balance": 100, "user.id": userId, ...req.body.variables };
      const { renderTemplate } = await import("../../modules/automations/engine/template-renderer.js");
      const text = template
        ? renderTemplate(template, lang, variables).text
        : "[No template]";
      if (deps.getBot?.()) {
        await deps.getBot()!.api.sendMessage(Number(userId), text, { parse_mode: "HTML" });
      }
      res.json({ sent: !!deps.getBot?.(), preview: text });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/event-log", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const repo = ds.getRepository(AutomationEventLog);
      const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
      const scenarioKey = (Array.isArray(req.query.scenarioKey) ? req.query.scenarioKey[0] : req.query.scenarioKey) as string | undefined;
      const qb = repo.createQueryBuilder("l").orderBy("l.createdAt", "DESC").take(limit).skip((page - 1) * limit);
      if (scenarioKey) qb.andWhere("l.scenarioKey = :scenarioKey", { scenarioKey });
      const [items, total] = await qb.getManyAndCount();
      res.json({ items, total, page, limit });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get("/offer-instances", async (req: Request, res: Response) => {
    try {
      const ds = await getAppDataSource();
      const repo = ds.getRepository(OfferInstance);
      const qb = repo.createQueryBuilder("o").orderBy("o.createdAt", "DESC").take(100);
      const userId = Array.isArray(req.query.userId) ? req.query.userId[0] : req.query.userId;
      const scenarioKeyQ = Array.isArray(req.query.scenarioKey) ? req.query.scenarioKey[0] : req.query.scenarioKey;
      const statusQ = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
      if (userId) qb.andWhere("o.userId = :userId", { userId });
      if (scenarioKeyQ) qb.andWhere("o.scenarioKey = :scenarioKey", { scenarioKey: scenarioKeyQ });
      if (statusQ) qb.andWhere("o.status = :status", { status: statusQ });
      const items = await qb.getMany();
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
