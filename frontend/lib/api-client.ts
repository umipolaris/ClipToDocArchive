const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/api";

export function buildApiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function formatErrorDetail(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw == null) {
    return "";
  }
  if (typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

function parseErrorMessageFromRaw(status: number, rawText: string): string {
  if (!rawText) {
    return `API error: ${status}`;
  }
  try {
    const parsed = JSON.parse(rawText) as { detail?: unknown };
    const detail = formatErrorDetail(parsed?.detail ?? parsed);
    return detail ? `API error: ${status} ${detail}` : `API error: ${status}`;
  } catch {
    const compact = rawText.replace(/\s+/g, " ").trim();
    return compact ? `API error: ${status} ${compact}` : `API error: ${status}`;
  }
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const raw = await res.text();
    return parseErrorMessageFromRaw(res.status, raw);
  } catch {
    return `API error: ${res.status}`;
  }
}

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
};

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(buildApiUrl(path), {
    cache: "no-store",
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  if (res.status === 204) {
    return {} as T;
  }
  const raw = await res.text();
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return apiFetch<T>(path, {
    method: "DELETE",
  });
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: form,
  });
}

export async function apiPostFormWithProgress<T>(
  path: string,
  form: FormData,
  onProgress?: (progress: UploadProgress) => void,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", buildApiUrl(path), true);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.onprogress = (event: ProgressEvent<EventTarget>) => {
      if (!onProgress) return;
      const total = event.lengthComputable ? event.total : 0;
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((event.loaded / total) * 100))) : 0;
      onProgress({
        loaded: event.loaded,
        total,
        percent,
      });
    };

    xhr.onerror = () => {
      reject(new Error("네트워크 오류"));
    };

    xhr.onload = () => {
      const status = xhr.status;
      const raw = typeof xhr.responseText === "string" ? xhr.responseText : "";
      if (status < 200 || status >= 300) {
        reject(new Error(parseErrorMessageFromRaw(status, raw)));
        return;
      }

      if (!raw) {
        resolve({} as T);
        return;
      }

      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new Error(`API error: ${status} invalid JSON response`));
      }
    };

    xhr.send(form);
  });
}
