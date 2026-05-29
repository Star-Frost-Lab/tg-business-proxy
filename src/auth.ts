import { Env } from './types';

const SESSION_COOKIE = 'tgp_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30天

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Access-Password',
};

// ── 生成 HMAC-SHA256 会话令牌（确定性，无需服务端存储）──────────
async function hmacToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode('tgproxy-session-v1'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(password));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * 验证请求认证状态
 * 优先级：Cookie（浏览器）> X-Access-Password 头（curl）> ?password= 参数
 */
export async function checkAuth(request: Request, env: Env): Promise<boolean> {
  // 1. Cookie（浏览器 UI 自动携带）
  const cookies = request.headers.get('Cookie') ?? '';
  const cookieMatch = cookies.match(/tgp_session=([A-Za-z0-9+/=]+)/);
  if (cookieMatch?.[1]) {
    const expected = await hmacToken(env.ACCESS_PASSWORD);
    if (cookieMatch[1] === expected) return true;
  }

  // 2. X-Access-Password 头（curl / SDK）
  const headerPwd = request.headers.get('X-Access-Password');
  if (headerPwd && headerPwd === env.ACCESS_PASSWORD) return true;

  // 3. Query 参数（兜底）
  const qp = new URL(request.url).searchParams.get('password');
  if (qp && qp === env.ACCESS_PASSWORD) return true;

  return false;
}

/** POST /login — 验证密码并设置 Cookie */
export async function loginHandler(request: Request, env: Env): Promise<Response> {
  let password = '';
  try {
    const body = await request.json<{ password?: string }>();
    password = body.password ?? '';
  } catch {
    return authError();
  }

  if (!password || password !== env.ACCESS_PASSWORD) {
    return authError();
  }

  const token  = await hmacToken(password);
  const isHttps = new URL(request.url).protocol === 'https:';
  const secure  = isHttps ? '; Secure' : '';

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
      ...CORS,
    },
  });
}

/** POST /logout — 清除 Cookie */
export function logoutHandler(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      ...CORS,
    },
  });
}

/** 401 响应 */
export function authError(): Response {
  return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/** 统一 JSON 响应（带 CORS）*/
export function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/** CORS preflight */
export function corsPreFlight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
