// OpenCode V2 transport. Service discovery owns startup and authentication;
// the released client owns endpoint names, envelopes and event decoding.
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { setTimeout as delay } from "node:timers/promises";

const REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS) || 1_800_000;
const PROMPT_TIMEOUT_MS = Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS) || 14_400_000;
const POLL_MS = Number(process.env.OPENCODE_COMPLETION_POLL_MS) || 5_000;

function explicitEndpoint() {
  const url = process.env.OPENCODE_SERVER_URL;
  if (!url) return undefined;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  return {
    url,
    auth: password ? { type: "basic", username: process.env.OPENCODE_SERVER_USERNAME || "opencode", password } : undefined,
  };
}

export async function discoverServer() {
  return explicitEndpoint() ?? await Service.discover({ version: (v) => v.startsWith("2.") });
}

export async function isServerRunning() {
  try {
    const endpoint = await discoverServer();
    if (!endpoint) return false;
    const info = await createClient(endpoint.url, { headers: Service.headers(endpoint) }).health();
    return info.version.startsWith("2.");
  } catch {
    return false;
  }
}

export async function ensureServer() {
  const endpoint = explicitEndpoint() ?? await Service.ensure({ version: (v) => v.startsWith("2.") });
  const info = await createClient(endpoint.url, { headers: Service.headers(endpoint) }).health();
  if (!info.version.startsWith("2.")) {
    throw new Error(`OpenCode V2 is required (server reports ${info.version}).`);
  }
  return endpoint;
}

function parseModel(model) {
  if (typeof model !== "string") return model;
  const slash = model.indexOf("/");
  const [id, variant] = model.slice(slash + 1).split("#");
  if (slash < 1 || !id) throw new Error("Model must be provider/model or provider/model#variant.");
  return { providerID: model.slice(0, slash), id, ...(variant ? { variant } : {}) };
}

export function extractResponseText(message) {
  if (typeof message === "string") return message;
  return (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function headlessPermissions(readOnly, allow = []) {
  const rules = [{ action: "question", resource: "*", effect: "deny" }];
  if (readOnly) {
    // A plan agent denies edits, but its shell permission can still mutate the
    // tree. Task sessions deny shell and subagents too. Review sessions opt
    // back in: OpenCode's built-in /review runs git and may call Explore.
    for (const action of ["edit", "shell", "subagent"]) {
      if (!allow.includes(action)) rules.push({ action, resource: "*", effect: "deny" });
    }
  }
  return rules;
}

function allowedActions(options) {
  return [
    ...(options.allowShell ? ["shell"] : []),
    ...(options.allowSubagent ? ["subagent"] : []),
  ];
}

export function createClient(baseUrl, opts = {}) {
  const headers = { ...opts.headers };
  if (opts.directory) headers["x-opencode-directory"] = opts.directory;
  const native = OpenCode.make({ baseUrl, headers });
  const requestOptions = () => ({ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const location = opts.directory ? { directory: opts.directory } : undefined;

  const agentModel = async (agent) => {
    if (!agent) return undefined;
    try {
      const agents = await client.listAgents();
      return (Array.isArray(agents) ? agents : agents?.data)?.find((a) => a.id === agent)?.model;
    } catch {
      return undefined; // fall back to the server default
    }
  };

  const client = {
    baseUrl,
    health: () => native.server.info({ signal: AbortSignal.timeout(3_000) }),
    listSessions: () => native.session.list({ directory: opts.directory }, requestOptions()),
    createSession: ({ readOnly = false, allowShell = false, allowSubagent = false, model, ...input } = {}) => native.session.create({
      ...input, location, model: parseModel(model),
      permissions: headlessPermissions(readOnly, allowedActions({ allowShell, allowSubagent })),
    }, requestOptions()),
    getSession: (sessionID) => native.session.get({ sessionID }, requestOptions()),
    deleteSession: (sessionID) => native.session.remove({ sessionID }, requestOptions()),
    abortSession: (sessionID) => native.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(10_000) }),
    getSessionStatus: () => native.session.active(requestOptions()),
    getSessionDiff: (sessionID) => native.session.diff({ sessionID }, requestOptions()),
    getMessages: async (sessionID, options = {}) => {
      const page = await native.message.list({ sessionID, order: "desc", ...options }, requestOptions());
      return page.data;
    },
    listAgents: () => native.agent.list({ location }, requestOptions()),
    listProviders: () => native.provider.list({ location }, requestOptions()),
    getConfig: () => native.config.get({ location }, requestOptions()),
    subscribeEvents: (options) => native.event.subscribe(options),
    vcsBase: async () => (await native.vcs.base({ location }, requestOptions())).data,
    vcsStatus: async () => (await native.vcs.status({ location }, requestOptions())).data ?? [],

    // Only an idle SESSION completes a job. A completed assistant tool-call
    // message is an intermediate step, not a terminal result in V2.
    readSessionResult: async (sessionID, startedAt = 0, signal) => {
      const timeout = AbortSignal.timeout(10_000);
      const request = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
      const [session, active, messages, inbox] = await Promise.all([
        native.session.get({ sessionID }, request), native.session.active(request),
        native.session.context({ sessionID }, request),
        native.session.inbox.list({ sessionID }, request),
      ]);
      const last = messages.findLast((m) => m.type === "assistant");
      const idle = session.time?.idle || 0;
      const terminal = !active[sessionID] && inbox.length === 0 && idle > 0 && idle >= startedAt;
      const error = messages.findLast((m) => m.type === "idle")?.error ?? last?.error;
      return {
        terminal, outcome: session.outcome, completed: idle, message: last,
        text: extractResponseText(last), finish: last?.finish,
        error: error?.message,
        lastUpdatedAt: session.time?.updated || 0,
      };
    },

    prepareSession: async (sessionID, options = {}) => {
      if (options.agent) await native.session.switchAgent({ sessionID, agent: options.agent }, requestOptions());
      // Without an explicit --model, use the model configured for the agent
      // instead of letting the server fall back to its own default.
      const model = options.model ? parseModel(options.model) : await agentModel(options.agent);
      if (model) await native.session.switchModel({ sessionID, model }, requestOptions());
      const session = await client.getSession(sessionID);
      const headless = headlessPermissions(options.readOnly || options.agent === "plan", allowedActions(options));
      await native.session.update({
        sessionID,
        permissions: [
          ...(session.permissions ?? []).filter((rule) =>
            !headless.some((restriction) => restriction.action === rule.action && restriction.resource === rule.resource)),
          ...headless,
        ],
      }, requestOptions());
      return session;
    },

    sendPromptAsync: async (sessionID, text, options = {}) => {
      await client.prepareSession(sessionID, options);
      // Keep default steering delivery so the task is consumed alongside any
      // pending Plan reminder, rather than leaving only the reminder runnable.
      return native.session.prompt({ sessionID, text }, requestOptions());
    },

    // session.command returns 204. The built-in command admits its own prompt
    // before that response, so completion is the next idle timestamp after the
    // session's pre-command clock.
    sendCommand: async (sessionID, name, text = "", options = {}) => {
      const before = await client.prepareSession(sessionID, options);
      const startedAt = Math.max(before.time?.idle || 0, before.time?.updated || 0) + 1;
      await native.session.command({ sessionID, name, text }, requestOptions());
      return client.waitForSession(sessionID, startedAt);
    },

    waitForSession: async (sessionID, startedAt) => {
      const signal = AbortSignal.timeout(PROMPT_TIMEOUT_MS);
      try {
        while (true) {
          signal.throwIfAborted();
          const result = await client.readSessionResult(sessionID, startedAt, signal);
          if (result.terminal) {
            if (result.outcome !== "succeeded" || !result.message) {
              throw new Error(result.error || `OpenCode session ${result.outcome || "ended without a response"}.`);
            }
            return result.message;
          }
          const pending = await native.permission.list({ sessionID }, { signal });
          if (pending.length) {
            throw new Error(`OpenCode needs permission for ${pending[0].action}: ${pending[0].resources.join(", ")}. Configure a narrow allow rule and retry; no global permissions were changed.`);
          }
          await delay(POLL_MS, undefined, { signal });
        }
      } catch (error) {
        await client.abortSession(sessionID).catch(() => {});
        throw error;
      }
    },

    sendPrompt: async (sessionID, text, options = {}) => {
      const admitted = await client.sendPromptAsync(sessionID, text, options);
      return client.waitForSession(sessionID, admitted.time.created);
    },
  };
  return client;
}

export async function connect(opts = {}) {
  const endpoint = opts.start === false ? await discoverServer() : await ensureServer();
  if (!endpoint) throw new Error("OpenCode V2 service is not running. Start OpenCode or run opencode service start.");
  const client = createClient(endpoint.url, { directory: opts.cwd, headers: Service.headers(endpoint) });
  return { ...client, serverInfo: { url: endpoint.url } };
}
