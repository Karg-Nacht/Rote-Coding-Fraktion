import { omniRouteBaseUrl } from "../shared/provider-url";
import type { ProviderModel } from "../shared/types";

async function errorDiagnostic(response: Response): Promise<string> {
  if (!response.headers.get("content-type")?.includes("json")) {
    await response.body?.cancel();
    return "";
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        return "";
      }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const safe = (value: unknown) =>
      typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value)
        ? value
        : undefined;
    const code = safe(data?.error?.code ?? data?.code);
    const correlation = safe(
      data?.error?.correlation_id ?? data?.correlation_id,
    );
    return [
      code ? `Код: ${code}.` : "",
      correlation ? `ID запроса: ${correlation}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  } catch {
    return "";
  } finally {
    reader.releaseLock();
  }
}

export function parseProviderModels(value: unknown): ProviderModel[] {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { data?: unknown }).data)
  )
    throw new Error("Сервер вернул неожиданный формат каталога моделей.");
  const records = (value as { data: unknown[] }).data;
  if (records.length > 10000)
    throw new Error("Каталог содержит слишком много моделей.");
  const models = new Map<string, ProviderModel>();
  for (const entry of records) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 300 ||
      /[\x00-\x1f\x7f]/.test(id)
    )
      continue;
    models.set(id, {
      id,
      name: typeof name === "string" ? name.slice(0, 160) : id,
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function providerModels(input: {
  baseUrl: string;
  key?: string;
}): Promise<ProviderModel[]> {
  const baseUrl = omniRouteBaseUrl(input.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: input.key?.trim()
        ? { Authorization: `Bearer ${input.key.trim()}` }
        : {},
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await errorDiagnostic(response);
      const fail = (message: string): never => {
        throw new Error([message, detail].filter(Boolean).join(" "));
      };
      if (response.status === 401 || response.status === 403)
        fail(
          `OmniRoute отклонил доступ (HTTP ${response.status}). Проверьте API ключ и его разрешения.`,
        );
      if (response.status === 429)
        fail("OmniRoute ограничил частоту запросов. Повторите позже.");
      if (response.status >= 500)
        fail(
          `OmniRoute или промежуточный шлюз вернул HTTP ${response.status}: сервер не смог обработать запрос каталога. Повторите позже; если ошибка сохраняется, проверьте состояние и журнал OmniRoute. Один этот ответ не указывает на ошибку URL или ключа.`,
        );
      if (response.status === 404)
        fail(
          "Каталог OmniRoute не найден (HTTP 404). Укажите API URL из Endpoints с /v1.",
        );
      fail(`Не удалось загрузить каталог OmniRoute (HTTP ${response.status}).`);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();
    if (reader)
      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          length += chunk.byteLength;
          if (length > 8 * 1024 * 1024) {
            controller.abort();
            throw new Error("Каталог моделей превышает 8 МБ.");
          }
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock();
      }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error(
        "OmniRoute вернул не JSON. Укажите API URL с /v1, а не адрес панели управления.",
      );
    }
    return parseProviderModels(data);
  } catch (error) {
    if (
      controller.signal.aborted &&
      (error as Error).message !== "Каталог моделей превышает 8 МБ."
    )
      throw new Error(
        "OmniRoute не ответил за 15 секунд. Проверьте адрес и доступность сервера.",
      );
    if (error instanceof TypeError) {
      const cause = (error as TypeError & { cause?: { code?: string } }).cause
        ?.code;
      if (cause === "ECONNREFUSED")
        throw new Error(
          new URL(baseUrl).hostname === "localhost" ||
            new URL(baseUrl).hostname === "127.0.0.1"
            ? "Соединение отклонено: локальный OmniRoute не запущен на указанном порту. Для удалённого сервера укажите его API URL из Endpoints вместо localhost."
            : "Соединение с OmniRoute отклонено. Проверьте, запущен ли сервер на указанном порту.",
        );
      if (cause === "ENOTFOUND")
        throw new Error(
          "Не удалось найти DNS-адрес OmniRoute. Проверьте имя сервера в Base URL.",
        );
      throw new Error(
        "Нет соединения с OmniRoute. Проверьте URL, сертификат и доступность сервера.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
