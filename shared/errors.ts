export function explainError(message: string): { title: string; hint: string } {
  if (/cool(?:ing)?\s*down|cooldown/i.test(message))
    return {
      title: "Провайдер временно приостановил запросы",
      hint: "Дождитесь окончания паузы или выберите другую модель. История и выполненные действия сохранены.",
    };
  if (
    /401|403|unauthori[sz]ed|authentication|user not found|invalid.{0,12}(?:key|credential)/i.test(
      message,
    )
  )
    return {
      title: "Провайдер отклонил авторизацию",
      hint: "Проверьте подключение в настройках. Выбранная модель и история сохранены.",
    };
  if (/429|rate.?limit|quota|usage limit|too many requests/i.test(message))
    return {
      title: "Достигнут лимит провайдера",
      hint: "Дождитесь возобновления доступа или выберите другую доступную модель.",
    };
  if (/timeout|timed out|deadline/i.test(message))
    return {
      title: "Превышено время ожидания",
      hint: "Проверьте соединение и продолжите задачу, когда провайдер станет доступен.",
    };
  if (
    /ECONN|ENOTFOUND|network|fetch failed|connection|socket|HTTP 50[0234]/i.test(
      message,
    )
  )
    return {
      title: "Нет связи с провайдером",
      hint: "Проверьте адрес сервера и соединение. История остаётся в текущем чате.",
    };
  if (
    /tool.{0,30}(?:invalid|malformed|parse)|(?:invalid|malformed).{0,30}tool/i.test(
      message,
    )
  )
    return {
      title: "Модель вернула некорректный вызов инструмента",
      hint: "Проверьте уже выполненные действия перед продолжением или сменой модели.",
    };
  if (/permission|EACCES|EPERM|access denied|доступ/i.test(message))
    return {
      title: "Операция ограничена разрешениями",
      hint: "Проверьте выбранное пространство и доступ к проекту.",
    };
  if (
    /model.{0,30}(?:not found|unavailable|not available|disabled)/i.test(
      message,
    )
  )
    return {
      title: "Модель недоступна",
      hint: "Проверьте каталог и выберите доступную модель. Подмена модели не выполняется.",
    };
  return {
    title: "Запрос завершился с ошибкой",
    hint: "История сохранена. Проверьте сообщение провайдера и продолжите задачу при необходимости.",
  };
}
