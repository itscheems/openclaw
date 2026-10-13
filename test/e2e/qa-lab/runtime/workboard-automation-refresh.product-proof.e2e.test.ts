import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import { generateStoredDeviceIdentity } from "../../../../src/infra/device-identity-store.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "../../../helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";

const MODEL_REF = "openai/gpt-5.6-luna";
const CASES = ["agent_end", "subagent_ended"] as const;
type Case = (typeof CASES)[number];
type ScriptState = { marker: string; boardId: string; calls: number };
type CronJobView = { id: string; state: { triggerState?: ScriptState; nextRunAtMs?: number } };

describe.runIf(process.env.OPENCLAW_WORKBOARD_AUTOMATION_REFRESH_PROOF === "1")(
  "Workboard automation refresh product proof",
  () => {
    it(
      "executes a nudged script through a built Gateway after worker completion",
      { timeout: 180_000 },
      async (context) => {
        let gateway: OpenClawTestInstance | undefined;
        let client: GatewayClient | undefined;
        const gates = new Map(
          CASES.map((kind) => [
            kind,
            {
              entered: createDeferredCore(),
              release: createDeferredCore(),
            },
          ]),
        );
        const completed = new Map<
          string,
          ReturnType<typeof createDeferredCore<Record<string, unknown>>>
        >();
        const requests: Case[] = [];
        const providerTasks = new Set<Promise<void>>();
        let provider: Awaited<ReturnType<typeof reserveTestPortListener<Server>>> | undefined;
        context.onTestFailed(() => console.error(gateway?.logs()));

        await runQaGatewayTestFixture(
          context,
          async ({ signal, verifyCleanup }) => {
            const server = createServer((request, response) => {
              const task = (async () => {
                if (request.method === "GET" && request.url === "/v1/models") {
                  response
                    .writeHead(200, { "content-type": "application/json" })
                    .end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
                  return;
                }
                if (request.method !== "POST" || request.url !== "/v1/responses") {
                  response.writeHead(404).end();
                  return;
                }
                const chunks: Buffer[] = [];
                for await (const chunk of request) {
                  chunks.push(Buffer.from(chunk));
                }
                const body = Buffer.concat(chunks).toString("utf8");
                const kind = CASES.find((candidate) =>
                  body.includes(`WORKBOARD_PROOF_${candidate}`),
                );
                if (!kind) {
                  throw new Error("Unexpected inference request");
                }
                const gate = gates.get(kind)!;
                requests.push(kind);
                gate.entered.resolve();
                await gate.release.promise;
                if (!response.destroyed) {
                  writeOpenAiResponsesText(response, {
                    text: "Worker complete.",
                    messageId: `message-${kind}`,
                    responseId: `response-${kind}`,
                  });
                }
              })().catch((error: unknown) => {
                if (!response.destroyed) {
                  response.writeHead(500).end(String(error));
                }
              });
              providerTasks.add(task);
              void task.finally(() => providerTasks.delete(task));
            });
            provider = await reserveTestPortListener({
              offsets: [0],
              createListener: () => server,
              signal,
              verifyCleanup,
            });
            gateway = await createOpenClawTestInstance({
              name: "workboard-automation-refresh",
              signal,
              verifyCleanup,
              entrypoint: [process.env.OPENCLAW_WORKBOARD_PROOF_GATEWAY_ENTRY ?? "dist/index.js"],
              stopTimeoutMs: 10_000,
              env: {
                NODE_ENV: "production",
                VITEST: undefined,
                OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
                OPENCLAW_SKIP_PROVIDERS: undefined,
                OPENCLAW_SKIP_CRON: undefined,
                OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
                OPENAI_API_KEY: "synthetic-key",
                CODEX_HOME: undefined,
                NO_PROXY: "127.0.0.1,localhost,::1",
                no_proxy: "127.0.0.1,localhost,::1",
              },
            });
            const observerDir = gateway.state.path("hook-observer");
            await fs.mkdir(observerDir, { recursive: true });
            await fs.writeFile(
              path.join(observerDir, "openclaw.plugin.json"),
              JSON.stringify({
                id: "workboard-proof-observer",
                activation: { onStartup: true },
                configSchema: { type: "object", additionalProperties: false },
              }),
            );
            await fs.writeFile(
              path.join(observerDir, "package.json"),
              JSON.stringify({
                name: "workboard-proof-observer",
                openclaw: { extensions: ["./index.cjs"] },
              }),
            );
            await fs.writeFile(
              path.join(observerDir, "index.cjs"),
              `module.exports = {
          id: 'workboard-proof-observer', register(api) {
            api.on('agent_end', (event, ctx) => api.logger.info('WORKBOARD_PROOF_HOOK ' + JSON.stringify({hook:'agent_end',sessionKey:ctx.sessionKey,runId:ctx.runId,success:event.success})));
            api.on('subagent_ended', (event) => api.logger.info('WORKBOARD_PROOF_HOOK ' + JSON.stringify({hook:'subagent_ended',sessionKey:event.targetSessionKey,runId:event.runId,outcome:event.outcome})));
            api.logger.info('WORKBOARD_PROOF_OBSERVER_READY');
          }
        };`,
            );
            await gateway.state.writeConfig({
              logging: { file: gateway.state.path("gateway.log") },
              update: { checkOnStart: false },
              gateway: {
                mode: "local",
                port: gateway.port,
                auth: { mode: "token", token: gateway.gatewayToken },
                tools: { allow: ["sessions_spawn"] },
                controlUi: { enabled: false, sessionObserver: false },
              },
              agents: {
                ownership: "explicit",
                entries: { main: {} },
                defaults: {
                  workspace: gateway.state.workspaceDir,
                  skipBootstrap: true,
                  model: { primary: MODEL_REF, fallbacks: [] },
                  utilityModel: "",
                  heartbeat: { every: "0m" },
                  models: {
                    [MODEL_REF]: {
                      agentRuntime: { id: "openclaw" },
                      params: { transport: "sse", openaiWsWarmup: false },
                    },
                  },
                  sandbox: { mode: "off" },
                },
              },
              models: {
                mode: "replace",
                providers: {
                  openai: {
                    baseUrl: `http://127.0.0.1:${provider.claim.port}/v1`,
                    api: "openai-responses",
                    apiKey: "synthetic-key",
                    request: { allowPrivateNetwork: true },
                    models: [
                      {
                        id: "gpt-5.6-luna",
                        name: "Synthetic proof model",
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 128000,
                        maxTokens: 1024,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      },
                    ],
                  },
                },
              },
              tools: {
                profile: "full",
                codeMode: false,
                toolSearch: false,
                alsoAllow: ["workboard"],
              },
              plugins: {
                allow: ["openai", "workboard", "workboard-proof-observer"],
                load: { paths: [observerDir] },
                slots: { memory: "none" },
                entries: {
                  openai: { enabled: true },
                  workboard: { enabled: true },
                  "workboard-proof-observer": {
                    enabled: true,
                    hooks: { allowConversationAccess: true },
                  },
                },
              },
            });
            console.log("WORKBOARD_GATEWAY_PROOF_PHASE gateway-start");
            await gateway.startGateway();
            console.log("WORKBOARD_GATEWAY_PROOF_PHASE gateway-ready");
            expect(gateway.child?.pid).toBeGreaterThan(0);
            expect(gateway.logs()).toContain("WORKBOARD_PROOF_OBSERVER_READY");
            expect(gateway.logs()).not.toContain('typed hook "agent_end" blocked');
            client = await acquireGatewayTestClient(
              {
                url: gateway.url,
                token: gateway.gatewayToken,
                env: gateway.env,
                deviceIdentity: generateStoredDeviceIdentity(),
                deviceAuthScope: gateway.url,
                sharedStateMode: "read-only",
                clientName: "openclaw-tui",
                mode: "ui",
                role: "operator",
                scopes: ["operator.admin", "operator.read", "operator.write"],
                onEvent(event) {
                  if (
                    event.event === "cron" &&
                    isRecord(event.payload) &&
                    event.payload.action === "finished" &&
                    typeof event.payload.jobId === "string"
                  ) {
                    completed.get(event.payload.jobId)?.resolve(event.payload);
                  }
                },
              },
              {
                timeoutMs: 30_000,
                timeoutMessage: "proof Gateway connection timed out",
                closeMessage: "proof Gateway connection closed",
                signal,
                verifyCleanup,
              },
            );
            const results: Record<string, unknown>[] = [];
            for (const kind of CASES) {
              console.log(`WORKBOARD_GATEWAY_PROOF_PHASE ${kind}-worker-start`);
              const boardId = `proof-${kind.replaceAll("_", "-")}`;
              const job = await client.request<CronJobView>(
                "cron.add",
                {
                  name: boardId,
                  agentId: "main",
                  enabled: true,
                  deleteAfterRun: false,
                  schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
                  sessionTarget: "isolated",
                  wakeMode: "next-heartbeat",
                  delivery: { mode: "none" },
                  payload: {
                    kind: "script",
                    toolsAllow: ["workboard_boards"],
                    script: `const result = await workboard_boards({}); if (!result.boards.some(board => board.id === ${JSON.stringify(boardId)})) throw new Error('proof board missing'); return { state: { marker: 'WORKBOARD_SCRIPT_TOOL_OK', boardId: ${JSON.stringify(boardId)}, calls: (trigger.state?.calls ?? 0) + 1 } };`,
                  },
                },
                { signal },
              );
              const completion = createDeferredCore<Record<string, unknown>>();
              completed.set(job.id, completion);
              await client.request(
                "workboard.boards.upsert",
                { id: boardId, automationJobId: job.id },
                { signal },
              );
              let card: WorkboardCard;
              let worker: { runId: string; sessionKey: string };
              if (kind === "agent_end") {
                const sessionKey = "agent:main:workboard-proof-agent-end";
                const accepted = await client.request<{ status: string; runId: string }>(
                  "chat.send",
                  {
                    sessionKey,
                    message: `WORKBOARD_PROOF_${kind}`,
                    deliver: false,
                    idempotencyKey: randomUUID(),
                  },
                  { signal },
                );
                expect(accepted.status).toBe("started");
                worker = { runId: accepted.runId, sessionKey };
                await gates.get(kind)!.entered.promise;
                card = (
                  await client.request<{ card: WorkboardCard }>(
                    "workboard.cards.create",
                    {
                      title: `WORKBOARD_PROOF_${kind}`,
                      status: "running",
                      agentId: "main",
                      boardId,
                      sessionKey,
                      runId: worker.runId,
                    },
                    { signal },
                  )
                ).card;
                gates.get(kind)!.release.resolve();
              } else {
                const invoked = await client.request<{
                  ok: boolean;
                  output: {
                    details: { status: string; childSessionKey: string; runId: string };
                  };
                }>(
                  "tools.invoke",
                  {
                    name: "sessions_spawn",
                    sessionKey: "agent:main:workboard-proof-agent-end",
                    args: {
                      task: `WORKBOARD_PROOF_${kind}`,
                      taskName: "workboard-proof-child",
                      agentId: "main",
                      runtime: "subagent",
                      mode: "run",
                      expectsCompletionMessage: false,
                    },
                  },
                  { signal },
                );
                expect(invoked).toMatchObject({ ok: true });
                expect(invoked.output.details.status).toBe("accepted");
                worker = {
                  runId: invoked.output.details.runId,
                  sessionKey: invoked.output.details.childSessionKey,
                };
                await gates.get(kind)!.entered.promise;
                card = (
                  await client.request<{ card: WorkboardCard }>(
                    "workboard.cards.create",
                    {
                      title: `WORKBOARD_PROOF_${kind}`,
                      status: "running",
                      agentId: "main",
                      boardId,
                      sessionKey: worker.sessionKey,
                      runId: worker.runId,
                    },
                    { signal },
                  )
                ).card;
                gates.get(kind)!.release.resolve();
              }
              const workerResult = await client.request<{ status: string }>(
                "agent.wait",
                { runId: worker.runId, timeoutMs: 60_000 },
                { signal, timeoutMs: 65_000 },
              );
              expect(workerResult.status).toBe("ok");
              console.log(`WORKBOARD_GATEWAY_PROOF_PHASE ${kind}-worker-ended`);
              const terminal = await completion.promise;
              expect(terminal).toMatchObject({ status: "ok" });
              const stored = await client.request<CronJobView>(
                "cron.get",
                { id: job.id },
                { signal },
              );
              expect(stored.state.triggerState).toEqual({
                marker: "WORKBOARD_SCRIPT_TOOL_OK",
                boardId,
                calls: 1,
              });
              const runs = await client.request<{
                entries: Array<{ status: string; runId: string }>;
              }>("cron.runs", { id: job.id, limit: 5 }, { signal });
              expect(runs.entries).toHaveLength(1);
              expect(runs.entries[0]?.status).toBe("ok");
              const cards = await client.request<{ cards: WorkboardCard[] }>(
                "workboard.cards.list",
                { boardId },
                { signal },
              );
              const current = cards.cards.find((entry) => entry.id === card.id)!;
              expect(current.status).toBe("review");
              const logs = gateway.logs();
              const hookObserved = logs
                .split("\n")
                .some(
                  (line) =>
                    line.includes("WORKBOARD_PROOF_HOOK ") &&
                    line.includes(`"hook":"${kind}"`) &&
                    line.includes(`"sessionKey":${JSON.stringify(worker.sessionKey)}`),
                );
              expect(hookObserved).toBe(true);
              expect(logs).toContain(`workboard automation nudge requested for board ${boardId}`);
              results.push({
                terminalHook: kind,
                hookSessionMatches: hookObserved,
                workerStatus: workerResult.status,
                cardStatus: current.status,
                cronStatus: runs.entries[0]?.status,
                scriptState: stored.state.triggerState,
                explicitCronRun: false,
              });
            }
            console.log(
              "WORKBOARD_GATEWAY_PROOF " +
                JSON.stringify({
                  entrypoint: "dist/index.js",
                  sourceHead: process.env.OPENCLAW_PROOF_HEAD_SHA ?? "local-checkout",
                  gatewayReady: true,
                  inference: "deterministic local Responses fixture",
                  cases: results,
                }),
            );
            expect(requests).toEqual([...CASES]);
          },
          async () => {
            for (const gate of gates.values()) {
              gate.release.resolve();
            }
          },
          () => client?.stopAndWait(),
          () => gateway?.cleanup(),
          async () => {
            provider?.listener.closeAllConnections();
            await provider?.releaseListener();
          },
          () => provider?.claim.release(),
          () => Promise.all(providerTasks),
        );
      },
    );
  },
);
