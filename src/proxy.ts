const TG_BASE = 'https://api.telegram.org';

/**
 * 透明代理：将 /bot{TOKEN}/{method} 请求原样转发至 Telegram 官方 API。
 * 现有使用官方 SDK 的代码只需更改 base URL，无需其他修改。
 * 认证通过 X-Access-Password 或 ?password= 传入（在调用前已完成验证）。
 */
export async function handleProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const upstream = new URL(`${TG_BASE}${url.pathname}${url.search}`);

  // 转发时剥除代理专用头，避免泄露给 Telegram
  const headers = new Headers(request.headers);
  headers.delete('X-Access-Password');
  headers.delete('Host');

  const resp = await fetch(upstream.toString(), {
    method: request.method,
    headers,
    body: request.body,
    // @ts-ignore - CF Workers redirect follow
    redirect: 'follow',
  });

  const newHeaders = new Headers(resp.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, X-Access-Password, Authorization');

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: newHeaders,
  });
}
