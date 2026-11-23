export function omniRouteBaseUrl(input: string): string {
  const url = new URL(input.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/\/v1\/?$/.test(url.pathname)
  )
    throw new Error(
      "Укажите корневой API URL OmniRoute с /v1, без ключа в адресе и без /chat/completions.",
    );
  return url.href.replace(/\/$/, "");
}
