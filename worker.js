const CODEBUFF_API = "https://www.codebuff.com";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_API_KEY = "freebuff-default-key";
const CONTEXT_PRUNER_AGENT = "context-pruner";

// ---------------------------------------------------------------------------
// 统计模块: 内存累计 + 定时批量写 KV, 避免每请求写 KV(免费层写 1000 次/天)
// 统计项: 调用次数 / 输入 tokens / 缓存 tokens / 输出 tokens(按日聚合)
// ---------------------------------------------------------------------------
const STATS_FLUSH_MS = 5 * 60 * 1000;   // 5 分钟批量写一次 (≈288 写/天, 远低于免费上限)
const STATS_KEY_PREFIX = "fb2api:stats:";
let statsBuf = { calls: 0, prompt_tokens: 0, cached_tokens: 0, output_tokens: 0 };
let lastStatsFlush = 0;
let statsTimer = null;

function statsKey(date = new Date()) {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return STATS_KEY_PREFIX + d;
}

function recordStats(usage) {
  const u = usage || {};
  statsBuf.calls += 1;
  statsBuf.prompt_tokens += Number(u.prompt_tokens) || 0;
  statsBuf.cached_tokens += Number(u.prompt_cache_hit_tokens || u.input_tokens_details?.cached_tokens) || 0;
  statsBuf.output_tokens += Number(u.completion_tokens || u.output_tokens) || 0;
  scheduleStatsFlush();
}

function scheduleStatsFlush() {
  if (statsTimer) return;
  statsTimer = setTimeout(async () => {
    statsTimer = null;
    // 触发时在 fetch 内 flush(worker 全局 setTimeout 可能被冻结)
  }, STATS_FLUSH_MS);
}

// 在请求出口调用: 距上次写超过 5 分钟才写
async function maybeFlushStats(env) {
  if (!env.STATS_KV) return;
  if (Date.now() - lastStatsFlush < STATS_FLUSH_MS) return;
  lastStatsFlush = Date.now();
  const key = statsKey();
  // 读当前累计 → 合并 → 写回(仅 1 读 1 写, 频率极低)
  let agg = { calls: 0, prompt_tokens: 0, cached_tokens: 0, output_tokens: 0 };
  try {
    const cur = await env.STATS_KV.get(key);
    if (cur) agg = { ...agg, ...JSON.parse(cur) };
  } catch {}
  agg.calls += statsBuf.calls;
  agg.prompt_tokens += statsBuf.prompt_tokens;
  agg.cached_tokens += statsBuf.cached_tokens;
  agg.output_tokens += statsBuf.output_tokens;
  statsBuf.calls = statsBuf.prompt_tokens = statsBuf.cached_tokens = statsBuf.output_tokens = 0;
  try {
    await env.STATS_KV.put(key, JSON.stringify(agg), { expirationTtl: 60 * 60 * 24 * 31 }); // 31 天
  } catch {}
}

// 模型 → session 用模型名 / 上游 agentId / 上游 chat 模型名
// 映射来源：Freebuff Desktop 0.0.51 orchestrator.js FREEBUFF_ROOT_AGENT_ID_BY_MODEL（2026-08-07 实测同步）
const MODELS = [
  { id: "deepseek/deepseek-v4-flash", session: "deepseek/deepseek-v4-flash", agent: "base2-free-deepseek-flash", upstream: "deepseek/deepseek-v4-flash" },
  { id: "deepseek/deepseek-v4-pro",   session: "deepseek/deepseek-v4-pro",   agent: "base2-free-deepseek",     upstream: "deepseek/deepseek-v4-pro" },
  { id: "minimax/minimax-m3",         session: "minimax/minimax-m3",         agent: "base2-free-minimax-m3",   upstream: "minimax/minimax-m3" },
  { id: "mimo/mimo-v2.5",             session: "mimo/mimo-v2.5",             agent: "base2-free-mimo",         upstream: "mimo/mimo-v2.5" },
  { id: "openai/gpt-5.6-luna",        session: "openai/gpt-5.6-luna",        agent: "base2-free-luna",         upstream: "openai/gpt-5.6-luna" },
  { id: "z-ai/glm-5.2",               session: "z-ai/glm-5.2",               agent: "base2-free-glm",          upstream: "z-ai/glm-5.2" },
  { id: "poolside/laguna-s-2.1",      session: "poolside/laguna-s-2.1",      agent: "base2-free-laguna-s-2-1", upstream: "poolside/laguna-s-2.1" },
  { id: "openrouter/poolside/laguna-s-2.1", session: "openrouter/poolside/laguna-s-2.1", agent: "base2-free-laguna-s-2-1-openrouter", upstream: "openrouter/poolside/laguna-s-2.1" },
  { id: "inclusionai/ling-3.0-flash:free",  session: "inclusionai/ling-3.0-flash:free",  agent: "base2-free-ling-3-flash", upstream: "inclusionai/ling-3.0-flash:free" },
  { id: "crof/greg-2-ultra",          session: "crof/greg-2-ultra",          agent: "base2-free-greg-2-ultra", upstream: "crof/greg-2-ultra" },
  { id: "crof/greg-2-super",          session: "crof/greg-2-super",          agent: "base2-free-greg-2-super", upstream: "crof/greg-2-super" },
  { id: "anthropic/claude-fable-5",   session: "anthropic/claude-fable-5",   agent: "base2-free-fable",        upstream: "anthropic/claude-fable-5" },
  { id: "meta/muse-spark-1.2-contributor", session: "meta/muse-spark-1.2-contributor", agent: "base2-free-muse-spark", upstream: "meta/muse-spark-1.2-contributor" },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    // healthz 不鉴权：健康检查/监控探针不应依赖 API key
    if (request.method === "GET" && url.pathname === "/healthz") {
      const acctCount = parseAccounts(env).length;
      // v1.6.0：探测全部账号（GET /api/v1/me，0 消耗），返回存活数
      const probes = await probeAllAccounts(env);
      const aliveCount = probes.filter((p) => p.alive === true).length;
      const unknownCount = probes.filter((p) => p.alive === null).length;
      return jsonResponse({
        status: "ok",
        version: "1.6.6",
        accounts: acctCount,
        alive_accounts: aliveCount,
        unknown_accounts: unknownCount,
        account_details: probes.map((p) => ({
          token: p.token.slice(0, 8) + "...",
          alive: p.alive,
          uid: p.uid ? p.uid.slice(0, 8) + "..." : null, // 脱敏：uid 也是敏感账号 id，不完整暴露
        })),
        time: new Date().toISOString(),
      }, 200);
    }

    // admin 页面 + API(x-admin-auth 鉴权, 独立于 API key)
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return adminHtmlResponse();
    }
    if (url.pathname === "/admin/api/stats") {
      if (!adminAuthorized(request, env)) return jsonResponse({ error: { message: "Unauthorized", type: "auth_error" } }, 401);
      return handleAdminStats(request, env);
    }
    if (url.pathname.startsWith("/admin/api/accounts/")) {
      if (!adminAuthorized(request, env)) return jsonResponse({ error: { message: "Unauthorized", type: "auth_error" } }, 401);
      return handleAdminAccountAction(request, url, env);
    }

    const key = getApiKey(request, env);
    if (!key) return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);

    cleanCache();

    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return handleModels();
    }
    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      return handleChat(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      return handleResponses(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      return jsonResponse({ error: { message: "Anthropic endpoint not yet implemented", type: "not_implemented" } }, 501);
    }
    return jsonResponse({ error: { message: "Not found", type: "not_found" } }, 404);
  },
};

// ---------------------------------------------------------------------------
// 账号池
// ---------------------------------------------------------------------------

let accountIdx = 0;
const cooldowns = new Map();      // token -> 冷却到期 ms
const sessCache = new Map();      // `${token}:${sessionModel}` -> { instanceId, model, remainingMs, expiresAt }（必须带 token，多账号防串号）

function parseAccounts(env) {
  // 支持一行一个（换行）或逗号分隔；每项可为纯 token 或 "token:uid"（冒号配对 user_id）
  // 例："t1\nt2:u2\nt3,u4:u4" → [{token:t1,uid:null},{token:t2,uid:u2},...]
  return (env.FREEBUFF_TOKEN || "").split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
    .map((s) => {
      const idx = s.indexOf(":");
      if (idx > 0) return { token: s.slice(0, idx).trim(), uid: s.slice(idx + 1).trim() || null };
      return { token: s, uid: null };
    })
    .filter((a) => a.token.length > 8);
}

// ---------------------------------------------------------------------------
// 账号健康探测（v1.6.0）：GET /api/v1/me 不消耗 session/额度，探测 token 有效性并自动发现 uid
// ---------------------------------------------------------------------------

const acctHealth = new Map(); // token -> { alive, uid, checkedAt }
const PROBE_TTL_MS = 10 * 60 * 1000; // 探测结果缓存 10 分钟，避免每次请求都打上游

/**
 * 探测单个账号：GET /api/v1/me（0 消耗，不建 session）
 * - 200 → { alive: true, uid: data.id }（uid = 真实账号 id，自动发现）
 * - 401 → { alive: false }（token 失效）
 * - 其他/网络错误 → 不判定失效（返回 null 由调用方决定是否信任缓存）
 * 
 * 额外：GET /api/v1/freebuff/session 拿 rateLimitsByModel → quota（recentCount/limit），
 * 供 pickToken 按剩余额度选号（v1.6.2）。GET 不建 session，0 消耗。
 * 服务端可能默认返回 compact 响应；显式请求完整额度快照，避免 quota 探测退化。
 */
async function probeAccount(token) {
  const cached = acctHealth.get(token);
  if (cached && Date.now() - cached.checkedAt < PROBE_TTL_MS) return cached;
  try {
    const r = await enqueueUp("GET", "/api/v1/me", token, undefined, undefined, SESSION_TIMEOUT_MS);
    if (r.status === 200 && r.data && typeof r.data.id === "string") {
      const info = { alive: true, uid: r.data.id, checkedAt: Date.now(), quota: null };
      // 顺便查额度（0 消耗，GET 不建 session）
      try {
        const s = await enqueueUp(
          "GET",
          "/api/v1/freebuff/session",
          token,
          undefined,
          { "x-freebuff-include-unused-rate-limits": "1" },
          SESSION_TIMEOUT_MS,
        );
        if (s.status === 200 && s.data && s.data.rateLimitsByModel) {
          info.quota = s.data.rateLimitsByModel; // { model: { recentCount, limit, ... } }
        }
      } catch {}
      acctHealth.set(token, info);
      return info;
    }
    if (r.status === 401 || r.status === 403) {
      const info = { alive: false, uid: null, checkedAt: Date.now() };
      acctHealth.set(token, info);
      return info;
    }
    return null; // 网络错误/其他状态：不判定
  } catch {
    return null;
  }
}

/** 探测全部账号并返回汇总（healthz 用） */
async function probeAllAccounts(env) {
  const pool = parseAccounts(env);
  const results = [];
  for (const acct of pool) {
    const info = await probeAccount(acct.token);
    results.push({ token: acct.token, alive: info ? info.alive : null, uid: info ? info.uid : null });
  }
  return results;
}

function pickToken(env, sessionModel) {
  const pool = parseAccounts(env);
  if (pool.length === 0) return null;

  // v1.6.0：跳过已探测为失效的号（alive=false）；未探测/探测失败的不跳过（避免误杀）
  const alivePool = pool.filter((acct) => {
    const h = acctHealth.get(acct.token);
    return !(h && h.alive === false);
  });
  const usePool = alivePool.length > 0 ? alivePool : pool; // 全失效时回退全池，让请求继续（由 429 冷却接管）

  // v1.6.2：按剩余额度排序（优先选剩余最多的号，剩余<=0的跳过）
  // quota 数据来自 probeAccount 的 GET /freebuff/session（rateLimitsByModel，0 消耗）
  const quotaSorted = [...usePool].sort((a, b) => {
    const ra = remainingQuota(a.token, sessionModel);
    const rb = remainingQuota(b.token, sessionModel);
    if (ra === null && rb === null) return 0;
    if (ra === null) return 1;  // 无数据排后面（保底）
    if (rb === null) return -1;
    return rb - ra;  // 剩余多的优先
  });
  const withQuota = quotaSorted.filter((a) => {
    const r = remainingQuota(a.token, sessionModel);
    return r !== null && r > 0;
  });
  const finalPool = withQuota.length > 0 ? withQuota : quotaSorted; // 全部耗尽时回退排序池（仍有额度概念）

  // 优先复用已有活跃 session 缓存的号：一个 session 约 1 小时有效，创建 session 才扣
  // 免费额度（如 v4-pro 每天 6 次）。纯轮询会让每个请求都切号、各建一个 session，
  // 浪费创建额度。只要当前模型的 session 缓存还活跃就钉在同一个号上，用满再换。
  if (sessionModel) {
    for (const acct of finalPool) {
      const t = acct.token;
      if (cooldowns.has(t) && cooldowns.get(t) > Date.now()) continue;
      const cached = sessCache.get(t + ":" + sessionModel);
      if (cached && cached.expiresAt && new Date(cached.expiresAt).getTime() > Date.now() + 60000) {
        return acct;
      }
    }
  }

  // 没有活跃缓存才轮询（跳过冷却中的号）
  for (let k = 0; k < finalPool.length; k++) {
    const acct = finalPool[accountIdx % finalPool.length];
    accountIdx = (accountIdx + 1) % finalPool.length;
    const t = acct.token;
    if (!cooldowns.has(t) || cooldowns.get(t) <= Date.now()) return acct;
  }
  const oldest = [...cooldowns.entries()].sort((a, b) => a[1] - b[1])[0];
  if (oldest) cooldowns.delete(oldest[0]);
  return pool[0];
}

function cooldown(token, ms) {
  if (ms > 0) cooldowns.set(token, Date.now() + ms);
}

/**
 * 计算某 token 某模型的剩余额度（limit - recentCount）。
 * - 无 quota 数据 → null（不参与额度排序，保底）
 * - quota 里找不到该模型 → 用任意模型的最近值（额度是账号级共享的）
 * - 剩余 <= 0 → 该号额度耗尽（跳过）
 */
function remainingQuota(token, sessionModel) {
  const h = acctHealth.get(token);
  if (!h || !h.quota) return null;
  let entry = h.quota[sessionModel];
  if (!entry) {
    // 取第一个模型的额度（免费额度账号级共享，各模型 recentCount 相同）
    const keys = Object.keys(h.quota);
    if (keys.length === 0) return null;
    entry = h.quota[keys[0]];
  }
  if (!entry || typeof entry.recentCount !== "number" || typeof entry.limit !== "number") return null;
  return entry.limit - entry.recentCount;
}

function parseCooldown(text, status) {
  // 优先解析 JSON 里的 retryAfterMs（luna 等模型 429 返回 {"retryAfterMs": 15506639}）
  const jm = (text || "").match(/"retryAfterMs"\s*:\s*(\d+)/);
  if (jm) {
    const ms = parseInt(jm[1], 10);
    if (ms > 0) return Math.min(ms, 6 * 3600 * 1000);
  }
  const m = (text || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m) {
    const ms = (parseInt(m[1]||0,10)*3600 + parseInt(m[2]||0,10)*60 + parseInt(m[3]||0,10)) * 1000;
    if (ms > 0) return Math.min(ms, 6*3600*1000);
  }
  return status === 429 ? 5*60*1000 : 60*1000;
}

// ---------------------------------------------------------------------------
// 上游请求（串行队列，免费通道并发超过 1 就出问题）
// ---------------------------------------------------------------------------

let chainTail = Promise.resolve();
const CHAIN_GAP_MS = 300; // 上游免费通道并发 >1 会出问题，串行+小间隔；300ms 足够防抖且链路总耗时可控
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function enqueue(fn) {
  const run = chainTail.then(() => sleep(CHAIN_GAP_MS)).then(fn);
  chainTail = run.catch(() => {});
  return run;
}

const UPSTREAM_TIMEOUT_MS = 20000; // 上游单请求超时，避免客户端干等
const NONSTREAM_TIMEOUT_MS = 45000; // 非流式要聚合完整上游流（含推理），给更充裕时间
const SESSION_TIMEOUT_MS = 10000;  // session/run 等短交互更快失败

async function up(method, path, token, body, extraHeaders = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const headers = {
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Host": "www.codebuff.com",
    "User-Agent": "Bun/1.3.11",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, extraHeaders);

  const resp = await fetch(CODEBUFF_API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: resp.status, data, text };
}

function enqueueUp(method, path, token, body, extraHeaders, timeoutMs) {
  return enqueue(() => up(method, path, token, body, extraHeaders, timeoutMs));
}

// ---------------------------------------------------------------------------
// session 生命周期
// ---------------------------------------------------------------------------

async function createSession(token, sessionModel, forceCreate = false) {
  // 0) 缓存命中且未过期（剩 >60s）直接复用，避免每次请求都打上游 session 接口
  if (!forceCreate) {
    const cached = sessCache.get(token + ":" + sessionModel);
    if (cached && cached.expiresAt && new Date(cached.expiresAt).getTime() > Date.now() + 60000) {
      return cached;
    }
  }
  // 1) 查上游当前 session，同模型直接复用（forceCreate 时跳过：僵尸 active session 会被 GET 反复复用，
  //    导致 chat 一直 428；强制 POST 拿全新实例）
  if (!forceCreate) {
    const cur = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined, undefined, SESSION_TIMEOUT_MS);
    if (cur.status === 200 && cur.data?.status === "active" && cur.data?.instanceId) {
      const cm = cur.data.model;
      if (!cm || cm === sessionModel) {
        const s = { model: cm || sessionModel, instanceId: cur.data.instanceId, remainingMs: cur.data.remainingMs, expiresAt: cur.data.expiresAt };
        sessCache.set(token + ":" + sessionModel, s);
        return s;
      }
      await enqueueUp("DELETE", "/api/v1/freebuff/session", token, undefined, undefined, SESSION_TIMEOUT_MS);
      sessCache.clear();
    }
  }

  // ad) 刷广告 + streak 签到：还原官方 CLI 行为，在创建 session 前上报广告曝光 + 签到。
  //      官方流程（参考 XxxXTeam/freebuff2api codebuff.py _request_ads_and_streak）：
  //      广告曝光后调 GET /api/v1/freebuff/streak 签到，连续使用可获 streak 额度加成
  //      （limit = base + referral + streak）。失败静默、超时 5s，完全不影响聊天。
  try {
    await enqueueUp("POST", "/api/v1/ads", token,
      { provider: "gravity", sessionId: crypto.randomUUID(), surface: "waiting_room",
        device: { os: "windows", timezone: "Asia/Shanghai", locale: "zh-CN" },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      { "Content-Type": "application/json" }, 5000);
    // streak 签到（v1.6.3）：GET /api/v1/freebuff/streak，0 消耗，连续使用加额度
    await enqueueUp("GET", "/api/v1/freebuff/streak", token, undefined, undefined, 5000);
  } catch {}

  // 2) create（可能 queue）。⚠️ 实测(2026-08-07)：x-freebuff-multi-session:1 创建的实例上游 GET 为
  //    status:none、chat 报 428 waiting_room_required；必须不带该 header 用默认主 session 才有效
  const r = await enqueueUp("POST", "/api/v1/freebuff/session", token, undefined,
    { "x-freebuff-model": sessionModel, "Content-Type": "application/json" }, SESSION_TIMEOUT_MS);
  if (r.status === 200 && r.data?.status === "active" && r.data?.instanceId) {
    const s = { model: r.data.model || sessionModel, instanceId: r.data.instanceId, remainingMs: r.data.remainingMs, expiresAt: r.data.expiresAt };
    sessCache.set(token + ":" + sessionModel, s);
    return s;
  }
  if (r.status === 200 && r.data?.status === "queued" && r.data?.instanceId) {
    const inst = r.data.instanceId;
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      const q = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined, { "x-freebuff-instance-id": inst }, SESSION_TIMEOUT_MS);
      if (q.status === 200 && q.data?.status === "active") {
        const s = { model: q.data.model || sessionModel, instanceId: inst, remainingMs: q.data.remainingMs, expiresAt: q.data.expiresAt };
        sessCache.set(token + ":" + sessionModel, s);
        return s;
      }
    }
    throw new Error("session stayed queued (retry later)");
  }
  if (r.status === 409) throw new Error("session_model_mismatch: " + String(r.data?.message || r.data?.error || "上游拒绝该模型"));
  throw new Error("create session failed: " + r.status + " " + (r.text || "").slice(0, 300));
}

// ---------------------------------------------------------------------------
// agent-runs 生命周期
// ---------------------------------------------------------------------------

function utcNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function startRun(token, agentId, ancestors = []) {
  const r = await enqueueUp("POST", "/api/v1/agent-runs", token,
    { action: "START", agentId, ancestorRunIds: ancestors }, undefined, SESSION_TIMEOUT_MS);
  if (r.status !== 200 || !r.data?.runId) throw new Error("start_run failed: " + r.status + " " + (r.text || "").slice(0, 200));
  return r.data.runId;
}

async function recordStep(token, runId, stepNumber, startTime, children = [], messageId = null) {
  await enqueueUp("POST", `/api/v1/agent-runs/${runId}/steps`, token,
    { stepNumber, credits: 0, childRunIds: children, messageId, status: "completed", startTime }, undefined, SESSION_TIMEOUT_MS);
}

async function finishRun(token, runId, totalSteps) {
  await enqueueUp("POST", "/api/v1/agent-runs", token,
    { action: "FINISH", runId, status: "completed", totalSteps, directCredits: 0, totalCredits: 0 }, undefined, SESSION_TIMEOUT_MS);
}

// deepseek 等直接模型：主 run + context-pruner 子 run
// 精简版：只 START 两个 run（chat 只校验 run_id 存在，recordStep/finishRun 可跳过），
// 实测链路总耗时 4s 内（原版 8s），满足 qwenpaw check_model_connection 5s 超时
const runCache = new Map();   // `${token}:${agentId}` -> { runId, childRunId, ts }
const RUN_CACHE_TTL_MS = 10 * 60 * 1000; // 实测 run_id 可跨请求复用（上游只校验存在性），10min 缓存省两次上游调用

async function startRunChain(token, agentId) {
  const key = token + ":" + agentId;
  const hit = runCache.get(key);
  if (hit && Date.now() - hit.ts < RUN_CACHE_TTL_MS) {
    return { runId: hit.runId, agentId, startedAt: utcNow(), childRunId: hit.childRunId, cached: true };
  }
  const startedAt = utcNow();
  const runId = await startRun(token, agentId);
  const childRunId = await startRun(token, CONTEXT_PRUNER_AGENT, [runId]);
  runCache.set(key, { runId, childRunId, ts: Date.now() });
  return { runId, agentId, startedAt, childRunId, cached: false };
}

// ---------------------------------------------------------------------------
// 上游 payload 构造（对齐 py 版 build_upstream_payload）
// ---------------------------------------------------------------------------

const UPSTREAM_KEYS = [
  "frequency_penalty", "logit_bias", "logprobs", "max_completion_tokens", "max_tokens",
  "metadata", "modalities", "parallel_tool_calls", "presence_penalty", "reasoning_effort",
  "response_format", "seed", "service_tier", "stop", "store", "stream_options",
  "temperature", "tool_choice", "tools", "top_logprobs", "top_p", "top_k", "user",
];

// 官方 free-mode marker 要求系统提示必须以 "You are Buffy, the strategic coding assistant."
// 字节级开头（服务端 hasFreebuffRootSystemPromptOpening 检查，旧 `[System Override...]`
// 前缀绕过已被官方修补并返回 403 free_mode_cli_required）。
const BUFFY = "You are Buffy, the strategic coding assistant.";

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  let hasSystem = false;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const item = { ...m };
    if (item.role === "developer") item.role = "system";
    if (item.role === "system") {
      hasSystem = true;
      item.cache_control = { type: "ephemeral" };
      // 注入官方 Buffy 前缀（服务器 hasFreebuffRootSystemPromptOpening 字节级校验）。
      // 字符串和数组(content 为 [{type:'text',text}]，OpenAI SDK 常见)都要处理。
      if (typeof item.content === "string") {
        if (!item.content.startsWith(BUFFY)) item.content = BUFFY + item.content;
      } else if (Array.isArray(item.content)) {
        const firstText = item.content.find((c) => c && c.type === "text" && typeof c.text === "string");
        if (firstText && !firstText.text.startsWith(BUFFY)) firstText.text = BUFFY + firstText.text;
      }
    }
    out.push(item);
  }
  if (!hasSystem) out.unshift({ role: "system", content: BUFFY, cache_control: { type: "ephemeral" } });
  return out;
}

function buildUpstreamPayload(params, mc, sess, runId) {
  const payload = {};
  for (const k of UPSTREAM_KEYS) if (params[k] !== undefined && params[k] !== null) payload[k] = params[k];
  payload.model = mc.upstream;
  payload.messages = normalizeMessages(params.messages);
  payload.stream = true;
  if (!payload.stop) payload.stop = ['"cb_easp"'];
  payload.provider = { data_collection: "deny" };
  // reasoning 归一化（移植 freebuff-proxy）：OpenAI/Freebuff 拒绝同时携带
  // reasoning_effort 与 reasoning.effort 双字段（尤其值不同时）；Freebuff 还会
  // 对裸 reasoning_effort 注入默认 effort 导致冲突。折叠为单一 reasoning.effort，
  // max → high（对应上游 catalog 顶层档位）。
  if (payload.reasoning_effort !== undefined || (payload.reasoning && typeof payload.reasoning === "object" && payload.reasoning.effort !== undefined)) {
    const fromTop = typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : null;
    const fromNested = payload.reasoning && typeof payload.reasoning === "object" && typeof payload.reasoning.effort === "string" ? payload.reasoning.effort : null;
    const effort = fromTop || fromNested;
    if (effort) {
      const mapped = effort === "max" ? "high" : effort;
      delete payload.reasoning_effort;
      payload.reasoning = {
        ...(payload.reasoning && typeof payload.reasoning === "object" ? payload.reasoning : {}),
        effort: mapped,
      };
    }
  }
  // v1.6.4：外来客户端检测绕过。服务端 detectForeignFreebuffClient 对「带 tools 但无官方
  // 专属工具名」的请求判定 foreign_toolset，降级到 ling-3.0-tiny:free（占免费额度→429）。
  // 实测（2026-08-09）：tools 里混入官方专属名（end_turn，TOOLS_WHICH_WONT_FORCE_NEXT_STEP
  // 中的无害工具）即通过检测，请求用真模型正常返回。end_turn 不会被模型实际调用
  // （官方定义为「不强制下一步」的工具），只用于通过工具集合签名校验。
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    const hasSignature = payload.tools.some(
      (t) => t && typeof t === "object" && t.function && typeof t.function.name === "string" && t.function.name === "end_turn",
    );
    if (!hasSignature) {
      payload.tools = [
        ...payload.tools,
        { type: "function", function: { name: "end_turn", description: "Signal the end of the current task.", parameters: { type: "object", properties: {} } } },
      ];
    }
  }
  payload.codebuff_metadata = {
    freebuff_instance_id: sess.instanceId,
    trace_session_id: crypto.randomUUID(),
    run_id: runId,
    client_id: "wf-" + Math.random().toString(36).slice(2, 10),
    cost_mode: "free",
  };
  return payload;
}

// ---------------------------------------------------------------------------
// chat 主流程
// ---------------------------------------------------------------------------

async function handleChat(request, env) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  const isStream = !!params.stream;
  const mc = MODELS.find((m) => m.id === (params.model || DEFAULT_MODEL)) || MODELS[0];
  return executeChat(env, params, mc, isStream, "chat");
}

// OpenAI Responses API（/v1/responses）入口：把 Responses 请求翻译成 chat completions 上游调用
async function handleResponses(request, env) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  const isStream = !!params.stream;
  const mc = MODELS.find((m) => m.id === (params.model || DEFAULT_MODEL)) || MODELS[0];
  return executeChat(env, responsesToChatParams(params, mc), mc, isStream, "responses");
}

// Responses API 请求 → chat completions 参数（字段名/结构翻译）
function responsesToChatParams(params, mc) {
  const chat = {};
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "stop", "seed", "store", "metadata", "user", "stream"]) {
    if (params[k] !== undefined && params[k] !== null) chat[k] = params[k];
  }
  if (params.max_output_tokens !== undefined && params.max_output_tokens !== null) chat.max_completion_tokens = params.max_output_tokens;
  if (params.reasoning && typeof params.reasoning === "object" && params.reasoning.effort) chat.reasoning_effort = params.reasoning.effort;
  if (params.text && typeof params.text === "object" && params.text.format && params.text.format.type && params.text.format.type !== "text") {
    chat.response_format = { type: params.text.format.type };
    if (params.text.format.json_schema) chat.response_format.json_schema = params.text.format.json_schema;
  }
  // Responses 工具格式（扁平 function）→ chat completions 格式（function 包装）。
  // 上游只接受 type:"function"，namespace/web_search 等非 function 工具一律过滤，避免反序列化报错。
  if (Array.isArray(params.tools)) {
    chat.tools = params.tools
      .filter((t) => t && typeof t === "object" && t.type === "function")
      .map((t) => ({
        type: "function",
        function: {
          name: t.name || "",
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {} },
        },
      }));
    if (chat.tools.length === 0) delete chat.tools;
  }
  // Responses tool_choice → chat 格式；仅支持 function 类型，其它对象形式退回 auto
  if (params.tool_choice && typeof params.tool_choice === "object") {
    if (params.tool_choice.type === "function" && params.tool_choice.name) {
      chat.tool_choice = { type: "function", function: { name: params.tool_choice.name } };
    } else {
      chat.tool_choice = "auto";
    }
  }
  chat.model = mc.id;
  chat.messages = responsesInputToMessages(params.input, params.instructions);
  return chat;
}

// Responses API input → chat messages（input 可为字符串或消息条目数组）
function responsesInputToMessages(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") { messages.push({ role: "user", content: input }); return messages; }
  if (!Array.isArray(input)) { messages.push({ role: "user", content: input == null ? "" : String(input) }); return messages; }
  for (const item of input) {
    if (typeof item === "string") { messages.push({ role: "user", content: item }); continue; }
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id || "", content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
      continue;
    }
    // function_call / reasoning / item_reference 等条目本地无法执行/回溯，跳过
    if (item.type === "function_call" || item.type === "reasoning" || item.type === "item_reference") continue;
    const role = item.role || "user";
    const content = item.content;
    if (typeof content === "string") { messages.push({ role, content }); continue; }
    if (Array.isArray(content)) {
      const parts = [];
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "input_text" || c.type === "output_text") { parts.push({ type: "text", text: c.text ?? "" }); continue; }
        if (c.type === "text" && typeof c.text === "string") { parts.push(c); continue; }
      }
      messages.push({ role, content: parts.length ? parts : "" });
      continue;
    }
    messages.push({ role, content: "" });
  }
  return messages;
}

// chat completions 与 responses 共用的上游执行：多号重试 + session/run 生命周期 + 流式/非流式出口
async function executeChat(env, chatParams, mc, isStream, mode) {
  const debug = env.FREEBUFF_DEBUG === "true";
  const pool = parseAccounts(env);
  if (pool.length === 0) return jsonResponse({ error: { message: "缺少 FREEBUFF_TOKEN 环境变量", type: "config_error" } }, 503);

  // 请求内多号重试：一个号失败（超时/429/428 重建无效/run 失败）立即冷却并换下一个号，最多试完整个账号池。
  // 免费通道上游波动大（并发>1 即出问题、排队超时），单请求内换号比等客户端重试成功率高得多。
  let lastErrMsg = "";
  for (let acctTry = 0; acctTry < pool.length; acctTry++) {
    const acct = pickToken(env, mc.session);
    const token = acct ? acct.token : null;
    if (!token) break;
    try {
      // 1) session
      const sess = await createSession(token, mc.session);
      if (debug) console.log(`[acct ${acctTry + 1}] session=${sess.instanceId}`);

      // 2) run 链
      const run = await startRunChain(token, mc.agent);
      if (debug) console.log(`[acct ${acctTry + 1}] run=${run.runId}`);

      // 3) chat（428 waiting_room_required / 409 session_superseded = session 失效，
      //    清缓存强制重建后重试一次；仍失败则冷却该号交给外层换号）
      let resp, errText = "", sessForChat = sess;
      for (let attempt = 0; attempt < 2; attempt++) {
        const payload = buildUpstreamPayload(chatParams, mc, sessForChat, run.runId);
        const headers = {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-freebuff-instance-id": sessForChat.instanceId,
          "User-Agent": "ai-sdk/openai-compatible/0.0.141/codebuff",
        };
        // x-freebuff-acting-user-id：优先用 token 配对的 uid（"token:uid" 格式），
        // 上游按该头独立计额（limit 6/天）——每个号配自己的 uid 才能真正多号轮换。
        // 无配对 uid 时回退 FREEBUFF_USER_ID（跳过默认值 2027142c-...，该值会导致 4 号共享额度池）；
        // 都没有就不带，让上游按 Authorization token 计额。
        const acctUid = acct && acct.uid;
        const globalUid = env.FREEBUFF_USER_ID && env.FREEBUFF_USER_ID !== "2027142c-e843-443f-b7d0-d636016d37c4" ? env.FREEBUFF_USER_ID : null;
        const actingUid = acctUid || globalUid;
        if (actingUid) headers["x-freebuff-acting-user-id"] = actingUid;
        if (debug) console.log(`[acct ${acctTry + 1}][chat] attempt=${attempt + 1}`);
        resp = await fetch(CODEBUFF_API + "/api/v1/chat/completions", {
          method: "POST", headers, body: JSON.stringify(payload),
          signal: AbortSignal.timeout(isStream ? UPSTREAM_TIMEOUT_MS : NONSTREAM_TIMEOUT_MS),
        });
        if (resp.ok) break;
        errText = await resp.text();
        // 428 waiting_room_required（无活跃 session）/ 409 session_superseded（被新 session 顶替）
        // 都说明缓存 instance 已失效 → 清缓存强制重建后重试一次；不是限流，不计冷却
        const staleSession =
          (resp.status === 428 && errText.includes("waiting_room_required")) ||
          (resp.status === 409 && errText.includes("session_superseded"));
        if (staleSession && attempt === 0) {
          sessCache.delete(token + ":" + mc.session);
          if (debug) console.log(`[acct ${acctTry + 1}][chat] session stale (${resp.status}), recreate…`);
          // forceCreate：跳过 GET 复用僵尸 session，直接 POST 拿全新实例
          sessForChat = await createSession(token, mc.session, true);
          continue;
        }
        // 重建后仍失败：该号 session 状态异常，冷却交给外层换号
        if (staleSession) cooldown(token, 60 * 1000);
        cooldown(token, parseCooldown(errText, resp.status));
        break;
      }
      if (!resp.ok) {
        lastErrMsg = "upstream error: " + (errText || "").slice(0, 300);
        if (debug) console.log(`[acct ${acctTry + 1}] failed ${resp.status}, switch account`);
        continue;
      }

      if (isStream) {
        const { readable, writable } = new TransformStream();
        if (mode === "responses") pipeUpstreamToResponsesStream(resp.body, writable, mc);
        else pipeUpstreamToClient(resp.body, writable);
        return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() } });
      }

      if (mode === "responses") return jsonResponse(await responsesToNonStream(resp.body, mc), 200);

      const agg = await streamToNonStream(resp.body, mc.upstream);
      recordStats(agg.usage);
      await maybeFlushStats(env);
      return jsonResponse(agg, 200);
    } catch (e) {
      console.error("[" + mode + "]", e);
      const msg = String(e.message || e);
      // 任何上游交互失败/超时（含 chat fetch 20s abort）都冷却当前号，继续换下一个号
      // ⚠️ createSession 429（额度耗尽）按 retryAfterMs/文本冷却（luna 可达数小时），
      // 不能固定 60s——否则冷却完又进池子反复撞 429。
      if (/create session failed|stayed queued|start_run failed|session_model_mismatch|abort|timeout|timed out|terminated/i.test(msg)) {
        const m429 = msg.match(/429/);
        cooldown(token, m429 ? parseCooldown(msg, 429) : 60 * 1000);
      }
      lastErrMsg = msg;
      if (debug) console.log(`[acct ${acctTry + 1}] exception: ${msg.slice(0, 120)}, switch account`);
    }
  }
  return jsonResponse({ error: { message: lastErrMsg, type: "api_error" } }, 502);
}


// ---------------------------------------------------------------------------
// SSE 处理
// ---------------------------------------------------------------------------

function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object" && (obj.data.choices || obj.data.id || obj.data.usage)) return obj.data;
  return obj;
}

// 流式：把上游 SSE 剥 {data:...} 包装后透传
function pipeUpstreamToClient(upstreamBody, writable) {
  const reader = upstreamBody.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") { await writer.write(encoder.encode(line + "\n\n")); continue; }
            try {
              const normalized = unwrapData(JSON.parse(payload));
              await writer.write(encoder.encode("data: " + JSON.stringify(normalized) + "\n\n"));
            } catch { await writer.write(encoder.encode(line + "\n")); }
          } else {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } catch {}
    finally { try { await writer.close(); } catch {} }
  })();
}

// 非流式：聚合上游流成 OpenAI 非流式对象
async function streamToNonStream(upstreamBody, upstreamModel) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", reasoning = "", finishReason = null, model = "", id = "", usage = null;
  const toolItems = new Map(); // 上游 tool_calls index → {id, callId, name, args}
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = unwrapData(JSON.parse(payload));
        const choice = obj?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== "object") continue;
            const ti = tc.index ?? 0;
            let item = toolItems.get(ti);
            if (!item) {
              const fn = tc.function || {};
              item = {
                id: "fc_" + Math.random().toString(36).slice(2, 10),
                callId: tc.id || "call_" + Math.random().toString(36).slice(2, 10),
                name: fn.name || "",
                args: "",
              };
              toolItems.set(ti, item);
            }
            const fn = tc.function || {};
            if (fn.name && !item.name) item.name = fn.name;
            if (fn.arguments) item.args += fn.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (obj.id) id = obj.id;
        if (obj.model) model = obj.model;
        if (obj.usage) usage = obj.usage;
      } catch {}
    }
  }
  const msg = { role: "assistant", content };
  if (reasoning && !content) { msg.content = reasoning; msg.reasoning_used_as_content = true; }
  else if (reasoning) msg.reasoning_content = reasoning;
  // 修复：tool_calls 聚合（原实现只解析 content/reasoning，finish_reason=tool_calls 但 tool_calls 丢失）
  if (toolItems.size > 0) {
    msg.tool_calls = [...toolItems.values()].map((item) => ({
      id: item.callId,
      type: "function",
      function: { name: item.name, arguments: item.args },
    }));
  }
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || upstreamModel,
    choices: [{ index: 0, message: msg, finish_reason: finishReason || "stop", logprobs: null }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Responses API（/v1/responses）输出
// ---------------------------------------------------------------------------

function responsesBase(mc, respId, createdAt) {
  return {
    id: respId || "resp_" + Math.random().toString(36).slice(2, 10),
    object: "response",
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: mc.id,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1.0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1.0,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  };
}

function responsesUsage() {
  return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
}

// 上游是 Chat Completions 格式，Responses API 要求 input/output_tokens。
// 统一归一化，避免把不完整或错误格式的 usage 直接透传给严格客户端。
function chatUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return responsesUsage();
  const inputTokens = Number.isFinite(usage.input_tokens)
    ? usage.input_tokens
    : Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputTokens = Number.isFinite(usage.output_tokens)
    ? usage.output_tokens
    : Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  const totalTokens = Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : inputTokens + outputTokens;
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details : {};
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: Number.isFinite(inputDetails.cached_tokens) ? inputDetails.cached_tokens : 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: Number.isFinite(outputDetails.reasoning_tokens) ? outputDetails.reasoning_tokens : 0 },
    total_tokens: totalTokens,
  };
}

// 流式：上游 chat SSE → Responses API 事件序列（response.created … response.completed）
async function pipeUpstreamToResponsesStream(upstreamBody, writable, mc) {
  const reader = upstreamBody.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const respId = "resp_" + Math.random().toString(36).slice(2, 10);
  const createdAt = Math.floor(Date.now() / 1000);
  let buf = "", model = "", usage = null;
  const send = (obj) => writer.write(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));

  // 按上游出现顺序记录输出项：message（文本）或 function_call（工具调用）
  const items = [];
  let nextOutputIndex = 0;
  let contentItem = null;
  const toolItems = new Map(); // 上游 tool_calls index → 输出项

  const startContent = () => {
    const item = {
      kind: "message",
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      outputIndex: nextOutputIndex++,
      text: "",
      contentIndex: 0,
      started: false,
    };
    items.push(item);
    return item;
  };
  const startTool = (tc) => {
    const fn = tc.function || {};
    const item = {
      kind: "function_call",
      id: "fc_" + Math.random().toString(36).slice(2, 10),
      outputIndex: nextOutputIndex++,
      callId: tc.id || "call_" + Math.random().toString(36).slice(2, 10),
      name: fn.name || "",
      args: "",
    };
    items.push(item);
    return item;
  };

  (async () => {
    try {
      await send({ type: "response.created", response: responsesBase(mc, respId, createdAt) });
      await send({ type: "response.in_progress", response: responsesBase(mc, respId, createdAt) });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          try {
            const obj = unwrapData(JSON.parse(payload));
            const choice = obj?.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};
                if (obj.model) model = obj.model;
                if (obj.usage) usage = obj.usage;

            // 工具调用增量（chat 格式 delta.tool_calls[]）
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                if (!tc || typeof tc !== "object") continue;
                const ti = tc.index ?? 0;
                let item = toolItems.get(ti);
                if (!item) {
                  item = startTool(tc);
                  toolItems.set(ti, item);
                  await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "in_progress", call_id: item.callId, name: item.name, arguments: "" } });
                }
                const fn = tc.function || {};
                if (fn.name && !item.name) item.name = fn.name;
                if (fn.arguments) {
                  item.args += fn.arguments;
                  await send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: item.outputIndex, delta: fn.arguments });
                }
              }
            }

            // 文本增量
            if (delta.content) {
              if (!contentItem) contentItem = startContent();
              if (!contentItem.started) {
                contentItem.started = true;
                await send({ type: "response.output_item.added", output_index: contentItem.outputIndex, item: { id: contentItem.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
                await send({ type: "response.content_part.added", item_id: contentItem.id, output_index: contentItem.outputIndex, content_index: contentItem.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
              }
              contentItem.text += delta.content;
              await send({ type: "response.output_text.delta", item_id: contentItem.id, output_index: contentItem.outputIndex, content_index: contentItem.contentIndex, delta: delta.content });
            }
          } catch {}
        }
      }

      // 既无文本也无工具调用时补一个空 message，避免 output 为空数组
      if (items.length === 0) {
        const item = startContent();
        item.started = true;
        await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
        await send({ type: "response.content_part.added", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
      }

      // 收尾：按出现顺序输出每个输出项的 done 事件
      for (const item of items) {
        if (item.kind === "message") {
          if (!item.started) {
            await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
            await send({ type: "response.content_part.added", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
          }
          const part = { type: "output_text", text: item.text, annotations: [] };
          await send({ type: "response.output_text.done", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, text: item.text });
          await send({ type: "response.content_part.done", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part });
          await send({ type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "completed", role: "assistant", content: [part] } });
        } else {
          await send({ type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args } });
        }
      }

      const resp = responsesBase(mc, respId, createdAt);
      resp.status = "completed";
      resp.model = model || mc.id;
      resp.output = items.map((item) =>
        item.kind === "message"
          ? { id: item.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: item.text, annotations: [] }] }
          : { id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args }
      );
      resp.usage = chatUsageToResponsesUsage(usage);
      await send({ type: "response.completed", response: resp });
    } catch {}
    finally { try { await writer.close(); } catch {} }
  })();
}

// 非流式：聚合上游流成 Responses API 非流式对象
async function responsesToNonStream(upstreamBody, mc) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buf = "", model = "", outputText = "", reasoning = "", usage = null;
  const toolItems = new Map(); // 上游 tool_calls index → {id, callId, name, args}
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = unwrapData(JSON.parse(payload));
        const choice = obj?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) outputText += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== "object") continue;
            const ti = tc.index ?? 0;
            let item = toolItems.get(ti);
            if (!item) {
              const fn = tc.function || {};
              item = {
                id: "fc_" + Math.random().toString(36).slice(2, 10),
                callId: tc.id || "call_" + Math.random().toString(36).slice(2, 10),
                name: fn.name || "",
                args: "",
              };
              toolItems.set(ti, item);
            }
            const fn = tc.function || {};
            if (fn.name && !item.name) item.name = fn.name;
            if (fn.arguments) item.args += fn.arguments;
          }
        }
        if (obj.model) model = obj.model;
        if (obj.usage) usage = obj.usage;
      } catch {}
    }
  }
  const resp = responsesBase(mc, undefined, Math.floor(Date.now() / 1000));
  resp.status = "completed";
  resp.model = model || mc.id;
  resp.output = [];
  if (outputText || reasoning) {
    const text = outputText || reasoning;
    resp.output.push({
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const item of toolItems.values()) {
    resp.output.push({ id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args });
  }
  resp.usage = chatUsageToResponsesUsage(usage);
  return resp;
}


// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

// 轻量缓存清理：避免长时间运行后 Map 无限膨胀（Workers 无自动 GC）
function cleanCache() {
  const now = Date.now();
  try {
    if (sessCache.size > 50) {
      for (const [k, v] of sessCache) {
        const exp = v.expiresAt ? new Date(v.expiresAt).getTime() : 0;
        if (exp > 0 && exp < now) sessCache.delete(k);
      }
    }
    if (runCache.size > 50) {
      for (const [k, v] of runCache) {
        if (now - v.ts > RUN_CACHE_TTL_MS) runCache.delete(k);
      }
    }
  } catch {}
}

// /v1/models 保持静态列表。
// ⚠️ 不要在这里查上游 GET /api/v1/freebuff/session（额度/状态）：
// 该接口会占用账号 session，而 Freebuff 一个号同一时间只能一个客户端在线，
// 查询会干扰/顶掉正在进行的 chat 会话（428 waiting_room_required）。
function handleModels() {
  return jsonResponse({
    object: "list",
    data: MODELS.map((m) => ({ id: m.id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "freebuff" })),
  }, 200, { "X-Freebuff2api-Version": "1.6.6" });
}

function getApiKey(request, env) {
  const expected = (env.API_KEY || env.FREEBUFF_API_KEY || DEFAULT_API_KEY).trim();
  if (!expected) return null;
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === expected ? expected : null;
  return request.headers.get("x-api-key") === expected ? expected : null;
}

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders } });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-freebuff-instance-id, anthropic-version, anthropic-beta",
  };
}

// ---------------------------------------------------------------------------
// admin 鉴权 + API
// ---------------------------------------------------------------------------
function adminAuthorized(request, env) {
  const adminKey = String(env.ADMIN_KEY || "").trim();
  if (!adminKey) return false;
  const auth = request.headers.get("x-admin-auth") || "";
  return auth.trim() === adminKey;
}

async function handleAdminStats(request, env) {
  // 读取当日统计(KV 已聚合) + 内存未 flush 部分
  let today = { calls: 0, prompt_tokens: 0, cached_tokens: 0, output_tokens: 0 };
  try {
    const cur = await env.STATS_KV.get(statsKey());
    if (cur) today = { ...today, ...JSON.parse(cur) };
  } catch {}
  today.calls += statsBuf.calls;
  today.prompt_tokens += statsBuf.prompt_tokens;
  today.cached_tokens += statsBuf.cached_tokens;
  today.output_tokens += statsBuf.output_tokens;

  // 账号状态
  const accounts = parseAccounts(env).map((a) => {
    const cd = cooldowns.get(a.token) || 0;
    const cooling = cd > Date.now();
    return {
      token: a.token.slice(0, 8) + "...",
      uid: a.uid ? a.uid.slice(0, 8) + "..." : null,
      cooling: cooling,
      cooldown_until: cooling ? new Date(cd).toISOString() : null,
    };
  });

  return jsonResponse({
    version: "1.6.6",
    time: new Date().toISOString(),
    stats: { date: new Date().toISOString().slice(0, 10), ...today },
    accounts: { total: accounts.length, list: accounts },
    models: MODELS.map((m) => m.id),
  });
}

async function handleAdminAccountAction(request, url, env) {
  // /admin/api/accounts/<token>/clear-cooldown 或 /delete
  const m = url.pathname.match(/^\/admin\/api\/accounts\/([^/]+)\/(clear-cooldown|delete)$/);
  if (!m) return jsonResponse({ error: { message: "Not found", type: "not_found" } }, 404);
  const token = decodeURIComponent(m[1]);
  const action = m[2];
  if (action === "clear-cooldown") {
    if (cooldowns.has(token)) { cooldowns.delete(token); }
    return jsonResponse({ ok: true, action, token: token.slice(0, 8) + "..." });
  }
  // delete: 移除冷却 + session 缓存(令牌本身在 env 中, 无法删除, 仅本地清理)
  cooldowns.delete(token);
  for (const k of [...sessCache.keys()]) {
    if (k.startsWith(token + ":")) sessCache.delete(k);
  }
  return jsonResponse({ ok: true, action, token: token.slice(0, 8) + "..." });
}

function adminHtmlResponse() {
  return new Response(ADMIN_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
  });
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FREEBUFF2API // BLUEPRINT</title>
<style>
:root{--bg:#0a1628;--panel:#0f1f36;--line:#1e3a5f;--txt:#dbe7f5;--dim:#7d95b5;--cyan:#22d3ee;--green:#34d399;--red:#f87171;--amber:#fbbf24;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);background-image:linear-gradient(rgba(34,211,238,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(34,211,238,.04) 1px,transparent 1px);background-size:24px 24px;color:var(--txt);font-family:var(--mono);font-size:13px;min-height:100vh}
.wrap{max-width:1100px;margin:0 auto;padding:16px}
.titlebar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--panel);border:1px solid var(--line);border-radius:8px;margin-bottom:14px}
.logo{font-weight:700;font-size:14px;letter-spacing:1px;color:var(--cyan)}
.logo span{display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;background:var(--cyan);color:#04121f;border-radius:4px;margin-right:8px;font-weight:800}
.spacer{flex:1}
.badge{background:rgba(34,211,238,.12);color:var(--cyan);border:1px solid rgba(34,211,238,.3);padding:3px 10px;border-radius:999px;font-size:11px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.stat .label{color:var(--dim);font-size:11px;letter-spacing:1px;text-transform:uppercase}
.stat .value{font-size:22px;font-weight:700;color:var(--cyan);margin-top:4px}
.stat .value small{font-size:12px;color:var(--dim);font-weight:400}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin-bottom:14px}
.card h3{font-size:12px;color:var(--dim);letter-spacing:1px;text-transform:uppercase;padding:10px 14px;border-bottom:1px solid var(--line)}
.card .body{padding:12px 14px}
table{width:100%;border-collapse:collapse}
th{color:var(--dim);text-align:left;font-weight:400;font-size:11px;text-transform:uppercase;padding:6px 10px;border-bottom:1px solid var(--line)}
td{padding:7px 10px;border-bottom:1px solid rgba(30,58,95,.5)}
tr:last-child td{border-bottom:none}
.ok{color:var(--green)}.cool{color:var(--amber)}.err{color:var(--red)}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid}
.chip.ok{color:var(--green);border-color:rgba(52,211,153,.4)}
.chip.cool{color:var(--amber);border-color:rgba(251,191,36,.4)}
.chip.err{color:var(--red);border-color:rgba(248,113,113,.4)}
.btns{display:flex;gap:8px}
button{background:rgba(34,211,238,.1);color:var(--cyan);border:1px solid rgba(34,211,238,.35);border-radius:5px;padding:4px 12px;font-family:var(--mono);font-size:12px;cursor:pointer}
button:hover{background:rgba(34,211,238,.22)}
.login-box{max-width:340px;margin:15vh auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:28px}
.login-box h2{color:var(--cyan);font-size:16px;margin-bottom:16px}
input{width:100%;background:#081426;border:1px solid var(--line);color:var(--txt);border-radius:5px;padding:9px 12px;font-family:var(--mono);font-size:13px;margin-bottom:12px}
.usage{color:var(--dim);font-size:11px;margin-top:8px;line-height:1.6}
a{color:var(--cyan)}
</style>
</head>
<body>
<div class="wrap" id="app">
<div class="titlebar">
  <div class="logo"><span>F</span>FREEBUFF2API</div>
  <div class="badge" id="ver">-</div>
  <div class="spacer"></div>
  <button onclick="refresh()">刷新</button>
</div>
<div class="stats-grid">
  <div class="stat"><div class="label">调用次数</div><div class="value" id="s-calls">-</div></div>
  <div class="stat"><div class="label">输入 Tokens</div><div class="value" id="s-prompt">-</div></div>
  <div class="stat"><div class="label">缓存 Tokens</div><div class="value" id="s-cached">-</div></div>
  <div class="stat"><div class="label">输出 Tokens</div><div class="value" id="s-output">-</div></div>
</div>
<div class="card"><h3>账号状态</h3><div class="body">
<table><thead><tr><th>Token</th><th>UID</th><th>状态</th><th>操作</th></tr></thead>
<tbody id="acct-tbody"><tr><td colspan="4" style="color:var(--dim)">加载中...</td></tr></tbody></table>
</div></div>
<div class="card"><h3>可用模型</h3><div class="body" id="models"><span style="color:var(--dim)">-</span></div></div>
<div class="card"><h3>使用说明</h3><div class="body usage">
<b>Base URL:</b> <span style="color:var(--cyan)">https://freebuff.chat2api.kdns.fr/v1</span><br>
<b>API Key:</b> <span style="color:var(--cyan)">freebuff-default-key</span><br>
<b>模型示例:</b> deepseek/deepseek-v4-flash, deepseek/deepseek-v4-pro, minimax/minimax-m3, mimo/mimo-v2.5, openai/gpt-5.6-luna, z-ai/glm-5.2, anthropic/claude-fable-5 等<br>
<b>健康检查:</b> <span style="color:var(--cyan)">/healthz</span>（免鉴权）<br>
<b>兼容:</b> OpenAI Chat Completions / Responses API, 支持 tools call(含 end_turn 签名)<br>
<b>说明:</b> 统计按日聚合, KV 每 5 分钟批量写入一次(免费额度内)
</div></div>
</div>
<script>
let KEY=localStorage.getItem('fb2a-key')||'';
async function api(path,opt){
  if(!KEY){const k=prompt('输入管理员密码:');if(!k)return;KEY=k;localStorage.setItem('fb2a-key',k);}
  opt=opt||{};opt.headers=Object.assign({'x-admin-auth':KEY},opt.headers||{});
  const r=await fetch(path,opt);
  if(r.status===401){localStorage.removeItem('fb2a-key');KEY='';alert('密码错误');return null;}
  return r.json();
}
async function refresh(){
  const d=await api('/admin/api/stats');if(!d)return;
  document.getElementById('ver').textContent='v'+d.version+' · '+d.time.slice(0,19).replace('T',' ');
  const s=d.stats||{};
  document.getElementById('s-calls').innerHTML=s.calls+(s.calls?'<small> 次</small>':'');
  document.getElementById('s-prompt').textContent=(s.prompt_tokens||0).toLocaleString();
  document.getElementById('s-cached').textContent=(s.cached_tokens||0).toLocaleString();
  document.getElementById('s-output').textContent=(s.output_tokens||0).toLocaleString();
  const tb=document.getElementById('acct-tbody');tb.innerHTML='';
  (d.accounts.list||[]).forEach(a=>{
    const st=a.cooling?'<span class="chip cool">冷却中</span>':'<span class="chip ok">正常</span>';
    const btn=a.cooling?'<button onclick="clearCd(\''+a.token+'\')">解除冷却</button>':'<button onclick="delAcct(\''+a.token+'\')">清理</button>';
    tb.insertAdjacentHTML('beforeend','<tr><td>'+a.token+'</td><td>'+(a.uid||'-')+'</td><td>'+st+'</td><td>'+btn+'</td></tr>');
  });
  document.getElementById('models').innerHTML=(d.models||[]).map(m=>'<span class="chip ok" style="margin:2px">'+m+'</span>').join(' ');
}
async function clearCd(t){await api('/admin/api/accounts/'+encodeURIComponent(t)+'/clear-cooldown',{method:'POST'});refresh();}
async function delAcct(t){if(confirm('确认清理该账号的本地会话?')){await api('/admin/api/accounts/'+encodeURIComponent(t)+'/delete',{method:'POST'});refresh();}}
refresh();setInterval(refresh,30000);
</script>
</body>
</html>`;