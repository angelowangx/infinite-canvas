/**
 * infinite-canvas — Cloudflare Worker
 *
 * 一个 Worker 同时承担两件事：
 *   1. /api/*    反向代理到上游 AI API（剥离 /api 前缀后转发）
 *   2. 其余路径   返回静态资源（ASSETS 绑定），未命中自动回退 index.html
 *
 * 为什么放 Worker 而不是 nginx：
 *   - 同域，浏览器不发预检，CORS 问题彻底消失
 *   - Worker 不是「源站」，路径上没有「回源」这一跳，因此不受 Cloudflare 100 秒超时限制
 *   - CORS 头用 set() 覆盖语义，不会像 nginx 的 add_header 那样与上游头叠加成重复值
 *
 * 两个绝对不能改的实现细节：
 *   - 请求体/响应体一律用 ReadableStream 直接透传，绝不 await .text()
 *     否则 SSE 流式响应会被缓冲，长耗时请求会被截断
 *   - 上游返回的 CORS 头必须先 delete 再 set
 *     浏览器规范要求 Access-Control-Allow-Origin 只能有一个值，出现两个即判定失败
 */

const DEFAULT_UPSTREAM = "https://new.jiangzishijie.top";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 自检端点：不转发，只回报当前配置，方便上线后一眼确认路由是否生效
    if (url.pathname === "/api/_health") {
      return handleHealth(request, env);
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleProxy(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};

function corsHeaders(request) {
  const requested = request.headers.get("Access-Control-Request-Headers");
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": requested || "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, X-Request-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function applyCors(headers, request) {
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }
}

function upstreamOf(env) {
  return (env.API_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, "");
}

function handleHealth(request, env) {
  const upstream = upstreamOf(env);
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  applyCors(headers, request);

  return new Response(
    JSON.stringify(
      {
        ok: true,
        service: "infinite-canvas-worker",
        upstream,
        proxyPrefix: "/api",
        example: "/api/v1/models  ->  " + upstream + "/v1/models",
        now: new Date().toISOString(),
      },
      null,
      2,
    ),
    { status: 200, headers },
  );
}

async function handleProxy(request, env, url) {
  // 预检直接放行，不打扰上游
  if (request.method === "OPTIONS") {
    const headers = new Headers();
    applyCors(headers, request);
    return new Response(null, { status: 204, headers });
  }

  const upstream = upstreamOf(env);
  // /api/v1/chat/completions  ->  <upstream>/v1/chat/completions，query 原样保留
  const target = upstream + url.pathname.replace(/^\/api/, "") + url.search;

  const headers = new Headers(request.headers);
  // 这些头是 Cloudflare / 客户端环境相关的，不能带给上游
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("x-forwarded-proto");
  headers.delete("x-real-ip");

  let upstreamRes;
  try {
    upstreamRes = await fetch(target, {
      method: request.method,
      headers,
      // 关键：body 直接透传 stream，不缓冲、不读取
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "manual",
    });
  } catch (err) {
    const failHeaders = new Headers({
      "Content-Type": "application/json; charset=utf-8",
    });
    applyCors(failHeaders, request);
    return new Response(
      JSON.stringify(
        {
          error: "upstream_unreachable",
          upstream,
          target,
          message: String((err && err.message) || err),
        },
        null,
        2,
      ),
      { status: 502, headers: failHeaders },
    );
  }

  const out = new Headers(upstreamRes.headers);
  // 先清掉上游自带的 CORS 头，再加自己的，避免出现重复值
  out.delete("access-control-allow-origin");
  out.delete("access-control-allow-credentials");
  out.delete("access-control-allow-methods");
  out.delete("access-control-allow-headers");
  out.delete("access-control-expose-headers");
  // 传输层头交给运行时重算（Workers 会自动解压上游响应，原始值会失真）
  out.delete("content-encoding");
  out.delete("content-length");
  applyCors(out, request);

  // 204 / 205 / 304 不允许携带响应体
  const noBody =
    upstreamRes.status === 204 ||
    upstreamRes.status === 205 ||
    upstreamRes.status === 304;

  return new Response(noBody ? null : upstreamRes.body, {
    status: upstreamRes.status,
    headers: out,
  });
}
