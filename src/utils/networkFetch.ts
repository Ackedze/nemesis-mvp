/// <reference types="@figma/plugin-typings" />

export async function fetchDirect(url: string): Promise<string> {
  const requestHTTPsAsync = (figma as any)?.requestHTTPsAsync;
  if (typeof requestHTTPsAsync === 'function') {
    return requestHTTPsAsync(url);
  }
  if (typeof fetch === 'function') {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
  }
  throw new Error(
    'Нет доступного API для загрузки данных (fetch/requestHTTPsAsync)',
  );
}
