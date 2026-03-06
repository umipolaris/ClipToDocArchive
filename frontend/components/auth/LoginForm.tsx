"use client";

import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiGet } from "@/lib/api-client";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/api";

type AuthUser = {
  id: string;
  username: string;
  role: "ADMIN" | "EDITOR" | "REVIEWER" | "VIEWER";
};

export function LoginForm() {
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("next");
  const nextPath = rawNext && rawNext.startsWith("/") ? rawNext : "/archive";

  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function checkAlreadyLoggedIn() {
      try {
        await apiGet<AuthUser>("/auth/me");
        if (!cancelled) {
          window.location.assign(nextPath);
        }
      } catch {
        // not logged in
      }
    }
    void checkAlreadyLoggedIn();
    return () => {
      cancelled = true;
    };
  }, [nextPath]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password, remember_me: rememberMe }),
      });

      if (!res.ok) {
        const raw = await res.text();
        let detail = raw;
        try {
          const body = JSON.parse(raw) as { detail?: unknown };
          const bodyDetail = body?.detail;
          if (typeof bodyDetail === "string") {
            detail = bodyDetail;
          } else if (bodyDetail != null) {
            detail = JSON.stringify(bodyDetail);
          }
        } catch {
          // fallback to raw body text
        }
        if (res.status === 423) {
          throw new Error("계정이 일시 잠금되었습니다. 잠시 후 다시 시도하세요.");
        }
        throw new Error(`로그인 실패 (${res.status}) ${detail}`);
      }

      window.location.assign(nextPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-stone-200 bg-panel p-6 shadow-panel">
      <div>
        <label className="mb-1 block text-sm text-stone-700">아이디</label>
        <input
          className="w-full rounded-md border border-stone-300 px-3 py-2"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-stone-700">비밀번호</label>
        <input
          type="password"
          className="w-full rounded-md border border-stone-300 px-3 py-2"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      <label className="inline-flex items-center gap-2 text-sm text-stone-700">
        <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
        자동 로그인
      </label>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <button
        type="submit"
        className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        disabled={busy}
      >
        {busy ? "로그인 중..." : "로그인"}
      </button>
    </form>
  );
}
