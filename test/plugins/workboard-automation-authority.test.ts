import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../extensions/workboard/api.js";
import plugin from "../../extensions/workboard/index.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../src/agents/admitted-run-context.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../../src/agents/plugin-runtime-refresh.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../src/agents/tools/gateway-caller-context.js";
import { CronService, type CronEvent } from "../../src/cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../src/cron/service.test-harness.js";
import { createCronScriptRuntime } from "../../src/cron/trigger-script.js";
import type { GatewayMethodDescriptorInput } from "../../src/gateway/methods/descriptor.js";
import { createGatewayMethodRegistry } from "../../src/gateway/methods/registry.js";
import { createScheduledGatewayRunner } from "../../src/gateway/scheduled-run-gateway-context.js";
import type { GatewayRequestHandler } from "../../src/gateway/server-methods/types.js";
import { createContext } from "../../src/gateway/server-plugin-in-process-dispatch.test-support.js";
import { dispatchTrustedPluginGatewayMethod } from "../../src/gateway/server-plugins.js";
import type { PluginHookHandlerMap } from "../../src/plugins/hook-types.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../../src/plugins/legacy-sdk-resource-host.js";
import { bindPluginRegistryRuntime } from "../../src/plugins/registry-runtime-binding.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../src/plugins/runtime/gateway-request-scope.js";
import { startPluginServices } from "../../src/plugins/services.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { createTestGatewayScheduler } from "../../src/test-utils/gateway-scheduler-clock.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "workboard-nudge-" });

describe("Workboard terminal hook automation ownership", () => {
  it.each([
    ["agent_end", "systemEvent"],
    ["subagent_ended", "systemEvent"],
    ["agent_end", "script"],
    ["subagent_ended", "script"],
  ] as const)("%s %s survives closure", async (hook, payloadKind) => {
    const sessionKey = "agent:main:subagent:workboard-d6-authority";
    const runId = `d6-${hook}`;
    const { storePath } = await makeStorePath();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(storePath));
    const gatewayContext = createContext();
    gatewayContext.resolveGatewayContext = () => gatewayContext;
    const finished = createDeferredCore<CronEvent>();
    let workboardToolFactory: OpenClawPluginToolFactory | undefined;
    const scriptRuntime = createCronScriptRuntime({
      config: {},
      prepareRuntime: async ({ jobId }) => ({
        context: { config: {}, agentId: "main", sessionKey: `agent:main:cron:${jobId}:trigger` },
        createTools: async () => {
          if (!workboardToolFactory) {
            throw new Error("Expected the registered Workboard tool factory");
          }
          const tools = workboardToolFactory({ config: {}, agentId: "main" });
          if (!Array.isArray(tools)) {
            throw new Error("Expected Workboard tools");
          }
          return tools.filter((tool) => tool.name === "workboard_boards");
        },
      }),
    });
    const executeJob = vi.fn(() => {
      expect(getGatewayToolCallerIdentity()).toBeUndefined();
      expect(getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.()).toBe(gatewayContext);
    });
    const scheduler = createTestGatewayScheduler();
    const resourceHost = new LegacyPluginSdkResourceHost();
    resourceHost.bindScheduler(scheduler);
    bindLegacyPluginSdkResourceHost(gatewayContext.resolveGatewayContext, resourceHost);
    const cron = new CronService({
      scheduler,
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: executeJob,
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runSchedulerOwned: createScheduledGatewayRunner(gatewayContext.resolveGatewayContext),
      runScriptJob: async (params) => {
        const result = await scriptRuntime.executePayload(params);
        return result.kind === "error"
          ? { status: "error", error: result.error }
          : { status: "ok", stateChanged: result.stateChanged, state: result.state };
      },
      onEvent: (event) => {
        if (event.action === "finished") {
          finished.resolve(event);
        }
      },
    });
    const job = await cron.add({
      name: "Workboard automation",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: payloadKind === "script" ? "isolated" : "main",
      wakeMode: "now",
      payload:
        payloadKind === "script"
          ? {
              kind: "script",
              toolsAllow: ["workboard_boards"],
              script:
                'return { state: (await workboard_boards({})).boards.some(board => board.id === "planning") };',
            }
          : { kind: "systemEvent", text: "categorize board" },
    });
    const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
    let agentEnd: PluginHookHandlerMap["agent_end"] | undefined;
    let subagentEnded: PluginHookHandlerMap["subagent_ended"] | undefined;
    const methods: GatewayMethodDescriptorInput[] = [];
    const captured = capturePluginRegistration({
      ...plugin,
      register(api) {
        api.registerTool = (factory, options) => {
          if (typeof factory === "function" && options?.names?.includes("workboard_boards")) {
            workboardToolFactory = factory;
          }
        };
        api.registerService = (service) => services.push(service);
        api.registerGatewayMethod = (name, handler, options) => {
          methods.push({
            name,
            handler,
            scope: options?.scope ?? "operator.admin",
            owner: { kind: "plugin", pluginId: "workboard" },
          });
        };
        api.on = (name, handler) => {
          if (name === "agent_end") {
            agentEnd = handler as typeof agentEnd;
          } else if (name === "subagent_ended") {
            subagentEnded = handler as typeof subagentEnded;
          }
        };
        plugin.register({
          ...api,
          runtimeSource: fileURLToPath(
            new URL("../../extensions/workboard/index.ts", import.meta.url),
          ),
          runtime: {
            ...api.runtime,
            gateway: {
              ...api.runtime.gateway,
              isAvailable: async () => true,
              request: dispatchTrustedPluginGatewayMethod,
            },
          },
        });
      },
    });
    const warn = vi.fn();
    const registry = createEmptyPluginRegistry();
    bindGatewayContextResolver(captured.api.runtime, () => gatewayContext);
    bindPluginRegistryRuntime(registry, captured.api.runtime);
    for (const service of services.filter((entry) =>
      ["workboard-automation-nudge", "workboard-lifecycle-sync"].includes(entry.id),
    )) {
      registry.services.push({
        pluginId: "workboard",
        origin: "bundled",
        source: "test",
        id: service.id,
        service: {
          ...service,
          apiVersion: 2,
          start: (ctx) =>
            withPluginRuntimeGatewayRequestScope(
              {
                pluginId: "workboard",
                pluginOrigin: "bundled",
                context: gatewayContext,
                isWebchatConnect: () => false,
              },
              () => service.start({ ...ctx, logger: { ...ctx.logger, warn } }),
            ),
        },
      });
    }
    const handle = await startPluginServices({
      scheduler,
      registry,
      config: {},
      getCronService: () => cron,
    });
    const enqueue = vi.spyOn(cron, "enqueueRun");
    const dispatch: GatewayRequestHandler = async ({ respond }) =>
      respond(true, await cron.enqueueRun(job.id, "if-enabled"));
    const describeSession: GatewayRequestHandler = ({ respond }) => {
      expect(getGatewayToolCallerIdentity()).toBeUndefined();
      respond(true, {
        session: {
          key: sessionKey,
          status: "done",
          hasActiveRun: false,
          updatedAt: Date.now(),
        },
      });
    };
    gatewayContext.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        ...methods,
        {
          name: "sessions.describe",
          scope: "operator.read",
          owner: { kind: "core", area: "sessions" },
          handler: describeSession,
        },
        {
          name: "cron.run",
          scope: "operator.admin",
          owner: { kind: "core", area: "cron" },
          handler: dispatch,
        },
      ]);
    const request = <T>(method: string, params: Record<string, unknown>) =>
      withPluginRuntimeGatewayRequestScope(
        {
          pluginId: "workboard",
          pluginOrigin: "bundled",
          context: gatewayContext,
          isWebchatConnect: () => false,
        },
        () => dispatchTrustedPluginGatewayMethod<T>(method, params, { scopes: ["operator.admin"] }),
      );
    const admission = prepareAgentRunAdmission({
      cfg: {},
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "d6-proof", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef(runId),
    });
    const refresh = createAgentPluginRuntimeRefresh();
    try {
      await request("workboard.boards.upsert", { id: "planning", automationJobId: job.id });
      const { card } = await request<{ card: WorkboardCard }>("workboard.cards.create", {
        title: "Completed worker",
        status: "running",
        boardId: "planning",
        sessionKey,
        runId,
      });
      const admittedRunContext = await admission.admit("plugin-harness", "codex");
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: "main",
        sessionKey,
      });
      if (!caller) {
        throw new Error("Expected an admitted worker caller");
      }
      await withPluginRuntimeGatewayRequestScope(
        {
          pluginId: "workboard",
          pluginOrigin: "bundled",
          context: gatewayContext,
          isWebchatConnect: () => false,
        },
        () =>
          refresh.run(() =>
            withGatewayToolCallerIdentity(caller, async () => {
              const pending =
                hook === "agent_end"
                  ? agentEnd!(
                      { messages: [], success: true },
                      { agentId: "main", sessionKey, runId },
                    )
                  : subagentEnded!(
                      {
                        targetSessionKey: sessionKey,
                        targetKind: "subagent",
                        runId,
                        endedAt: card.updatedAt + 1,
                        outcome: "ok",
                        reason: "subagent-complete",
                      },
                      { childSessionKey: sessionKey, runId },
                    );
              admission.close();
              refresh.close();
              await pending;
              expect(captureAgentPluginRuntimeRefresh().assertCurrent).toThrow(
                "Plugin runtime changed",
              );
              await expect(
                dispatchTrustedPluginGatewayMethod(
                  "cron.run",
                  { id: job.id, mode: "if-enabled" },
                  { scopes: ["operator.admin"] },
                ),
              ).rejects.toThrow("agent tool caller authority is no longer active");
            }),
          ),
      );

      await withGatewayToolCallerIdentity({ ...caller }, async () => {
        await expect(request("cron.run", { id: job.id, mode: "if-enabled" })).rejects.toThrow(
          "agent tool caller authority is no longer active",
        );
      });
      await expect(request("workboard.cards.list", { boardId: "planning" })).resolves.toMatchObject(
        {
          cards: [expect.objectContaining({ id: card.id, status: "review" })],
        },
      );
      expect(
        enqueue,
        "the service-owned automation must survive closure of the completed worker caller",
      ).toHaveBeenCalledOnce();
      await expect(finished.promise).resolves.toMatchObject({ status: "ok", error: undefined });
      if (payloadKind === "script") {
        const jobs = await cron.list({ includeDisabled: true });
        expect(jobs.find((entry) => entry.id === job.id)?.state.triggerState).toBe(true);
      } else {
        expect(executeJob).toHaveBeenCalledOnce();
      }
      // The sibling terminal event for the same card shares the service's debounce owner.
      await agentEnd!({ messages: [], success: true }, { agentId: "main", sessionKey, runId });
      expect(enqueue).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      admission.close();
      refresh.close();
      await handle.stop();
      cron.stop();
      await resourceHost.close();
      await scheduler.stop();
      for (const lifecycle of captured.runtimeLifecycles) {
        await lifecycle.dispose?.();
      }
      vi.unstubAllEnvs();
    }
  });
});
