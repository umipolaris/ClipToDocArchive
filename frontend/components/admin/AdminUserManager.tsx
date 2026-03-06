"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCcw, Search, Shield, User, Users } from "lucide-react";
import { apiFetch, apiGet, apiPost } from "@/lib/api-client";
import { userRoleLabel } from "@/lib/labels";

type UserRole = "ADMIN" | "EDITOR" | "REVIEWER" | "VIEWER";

type UserSummary = {
  id: string;
  username: string;
  role: UserRole;
  is_active: boolean;
  failed_login_attempts: number;
  locked_until: string | null;
  created_at: string;
  last_login_at: string | null;
};

type UsersListResponse = {
  items: UserSummary[];
  page: number;
  size: number;
  total: number;
};

type AuthMe = {
  id: string;
  username: string;
  role: UserRole;
};

type UpdateUserRequest = {
  role?: UserRole;
  is_active?: boolean;
  password?: string;
  password_confirm?: string;
  unlock_account?: boolean;
};

type DeleteUserResponse = {
  id: string;
  username: string;
  deleted: boolean;
  nullified_refs: Record<string, number>;
};

type SecurityPolicy = {
  scope: string;
  password_min_length: number;
  require_uppercase: boolean;
  require_lowercase: boolean;
  require_digit: boolean;
  require_special: boolean;
  max_failed_attempts: number;
  lockout_seconds: number;
  auto_login_days: number;
  updated_at: string | null;
};

const ROLE_OPTIONS: UserRole[] = ["ADMIN", "EDITOR", "REVIEWER", "VIEWER"];
const PAGE_SIZE = 20;
const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  scope: "auth",
  password_min_length: 10,
  require_uppercase: true,
  require_lowercase: true,
  require_digit: true,
  require_special: true,
  max_failed_attempts: 5,
  lockout_seconds: 900,
  auto_login_days: 7,
  updated_at: null,
};

function normalizeSecurityPolicy(input: Partial<SecurityPolicy> | null | undefined): SecurityPolicy {
  const merged = {
    ...DEFAULT_SECURITY_POLICY,
    ...(input || {}),
  } as SecurityPolicy;
  return {
    ...merged,
    auto_login_days:
      Number.isFinite(merged.auto_login_days) && merged.auto_login_days >= 1 && merged.auto_login_days <= 365
        ? Math.round(merged.auto_login_days)
        : 7,
  };
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? "-" : dt.toLocaleString("ko-KR");
}

function validatePasswordInput(password: string, policy: SecurityPolicy): string | null {
  if (password.length < policy.password_min_length) {
    return `비밀번호는 최소 ${policy.password_min_length}자 이상이어야 합니다.`;
  }
  if (policy.require_uppercase && !/[A-Z]/.test(password)) return "영문 대문자를 1자 이상 포함해야 합니다.";
  if (policy.require_lowercase && !/[a-z]/.test(password)) return "영문 소문자를 1자 이상 포함해야 합니다.";
  if (policy.require_digit && !/[0-9]/.test(password)) return "숫자를 1자 이상 포함해야 합니다.";
  if (policy.require_special && !/[^A-Za-z0-9]/.test(password)) return "특수문자를 1자 이상 포함해야 합니다.";
  return null;
}

function formatPolicySummary(policy: SecurityPolicy): string {
  const rules: string[] = [`${policy.password_min_length}자 이상`];
  if (policy.require_uppercase) rules.push("대문자");
  if (policy.require_lowercase) rules.push("소문자");
  if (policy.require_digit) rules.push("숫자");
  if (policy.require_special) rules.push("특수문자");
  return `비밀번호 정책: ${rules.join(", ")} 포함 | 로그인 실패 ${policy.max_failed_attempts}회 시 ${policy.lockout_seconds}초 잠금 | 자동 로그인 ${policy.auto_login_days}일`;
}

export function AdminUserManager() {
  const [currentUserId, setCurrentUserId] = useState("");
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, UserRole>>({});
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [passwordConfirmDrafts, setPasswordConfirmDrafts] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<UserRole | "">("");
  const [activeFilter, setActiveFilter] = useState<"" | "true" | "false">("");
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("VIEWER");
  const [creating, setCreating] = useState(false);
  const [policy, setPolicy] = useState<SecurityPolicy>(DEFAULT_SECURITY_POLICY);
  const [policyDraft, setPolicyDraft] = useState<SecurityPolicy>(DEFAULT_SECURITY_POLICY);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policySaving, setPolicySaving] = useState(false);

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadSecurityPolicy = useCallback(async () => {
    setPolicyLoading(true);
    try {
      const res = await apiGet<SecurityPolicy>("/admin/security-policy");
      const normalized = normalizeSecurityPolicy(res);
      setPolicy(normalized);
      setPolicyDraft(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : "보안 정책 로드 실패");
      setPolicy(DEFAULT_SECURITY_POLICY);
      setPolicyDraft(DEFAULT_SECURITY_POLICY);
    } finally {
      setPolicyLoading(false);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("size", String(PAGE_SIZE));
      if (query.trim()) params.set("q", query.trim());
      if (roleFilter) params.set("role", roleFilter);
      if (activeFilter) params.set("is_active", activeFilter);

      const res = await apiGet<UsersListResponse>(`/admin/users?${params.toString()}`);
      setUsers(res.items);
      setTotal(res.total);
      setRoleDrafts(Object.fromEntries(res.items.map((u) => [u.id, u.role])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "사용자 목록 로드 실패");
    } finally {
      setLoading(false);
    }
  }, [activeFilter, page, query, roleFilter]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    void loadSecurityPolicy();
  }, [loadSecurityPolicy]);

  useEffect(() => {
    let cancelled = false;
    async function loadMe() {
      try {
        const me = await apiGet<AuthMe>("/auth/me");
        if (!cancelled) setCurrentUserId(me.id);
      } catch {
        if (!cancelled) setCurrentUserId("");
      }
    }
    void loadMe();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const updateUser = async (userId: string, payload: UpdateUserRequest, successMessage: string) => {
    setBusyUserId(userId);
    setError("");
    setMessage("");
    try {
      await apiFetch<UserSummary>(`/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setMessage(successMessage);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "사용자 수정 실패");
    } finally {
      setBusyUserId(null);
    }
  };

  const resetPassword = async (user: UserSummary) => {
    const password = (passwordDrafts[user.id] || "").trim();
    const confirmPassword = (passwordConfirmDrafts[user.id] || "").trim();
    if (password.length < policy.password_min_length) {
      setError(`비밀번호는 ${policy.password_min_length}자 이상이어야 합니다.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("비밀번호 확인 값이 일치하지 않습니다.");
      return;
    }
    const passwordError = validatePasswordInput(password, policy);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    await updateUser(
      user.id,
      { password, password_confirm: confirmPassword },
      `비밀번호 재설정 완료: ${user.username}`,
    );
    setPasswordDrafts((prev) => ({ ...prev, [user.id]: "" }));
    setPasswordConfirmDrafts((prev) => ({ ...prev, [user.id]: "" }));
  };

  const createUser = async () => {
    if (!newUsername.trim() || !newPassword.trim()) {
      setError("아이디/비밀번호를 입력하세요.");
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setError("비밀번호 확인 값이 일치하지 않습니다.");
      return;
    }
    const passwordError = validatePasswordInput(newPassword, policy);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setCreating(true);
    setError("");
    setMessage("");
    try {
      await apiPost<UserSummary>("/admin/users", {
        username: newUsername.trim(),
        password: newPassword,
        password_confirm: newPasswordConfirm,
        role: newRole,
      });
      setMessage(`사용자 생성 완료: ${newUsername.trim()}`);
      setNewUsername("");
      setNewPassword("");
      setNewPasswordConfirm("");
      setNewRole("VIEWER");
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "사용자 생성 실패");
    } finally {
      setCreating(false);
    }
  };

  const saveSecurityPolicy = async () => {
    if (policyDraft.password_min_length < 6) {
      setError("최소 길이는 6 이상이어야 합니다.");
      return;
    }
    if (policyDraft.max_failed_attempts < 1) {
      setError("로그인 실패 허용 횟수는 1 이상이어야 합니다.");
      return;
    }
    if (policyDraft.lockout_seconds < 60) {
      setError("잠금 시간은 60초 이상이어야 합니다.");
      return;
    }
    if (policyDraft.auto_login_days < 1 || policyDraft.auto_login_days > 365) {
      setError("자동 로그인 기간은 1~365일 사이여야 합니다.");
      return;
    }

    setPolicySaving(true);
    setError("");
    setMessage("");
    try {
      const saved = await apiFetch<SecurityPolicy>("/admin/security-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password_min_length: policyDraft.password_min_length,
          require_uppercase: policyDraft.require_uppercase,
          require_lowercase: policyDraft.require_lowercase,
          require_digit: policyDraft.require_digit,
          require_special: policyDraft.require_special,
          max_failed_attempts: policyDraft.max_failed_attempts,
          lockout_seconds: policyDraft.lockout_seconds,
          auto_login_days: policyDraft.auto_login_days,
        }),
      });
      const normalized = normalizeSecurityPolicy(saved);
      setPolicy(normalized);
      setPolicyDraft(normalized);
      setMessage("보안 정책 저장 완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : "보안 정책 저장 실패");
    } finally {
      setPolicySaving(false);
    }
  };

  const deleteUser = async (user: UserSummary) => {
    if (user.id === currentUserId) {
      setError("현재 로그인한 관리자 계정은 삭제할 수 없습니다.");
      return;
    }

    const ok = window.confirm(`사용자 '${user.username}' 계정을 삭제하시겠습니까?`);
    if (!ok) return;

    setBusyUserId(user.id);
    setError("");
    setMessage("");
    try {
      await apiFetch<DeleteUserResponse>(`/admin/users/${user.id}`, { method: "DELETE" });
      setMessage(`사용자 삭제 완료: ${user.username}`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "사용자 삭제 실패");
    } finally {
      setBusyUserId(null);
    }
  };

  const applySearch = () => {
    setQuery(queryInput);
    setPage(1);
  };

  const clearFilters = () => {
    setQueryInput("");
    setQuery("");
    setRoleFilter("");
    setActiveFilter("");
    setPage(1);
  };

  return (
    <section className="space-y-4">
      <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-1 text-sm font-semibold">
            <Shield className="h-4 w-4 text-accent" />
            로그인 보안 정책
          </h2>
          <div className="flex gap-1">
            <button
              className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
              onClick={() => setPolicyDraft(policy)}
              disabled={policySaving || policyLoading}
            >
              되돌리기
            </button>
            <button
              className="rounded bg-accent px-2 py-1 text-xs text-white disabled:opacity-50"
              onClick={() => void saveSecurityPolicy()}
              disabled={policySaving || policyLoading}
            >
              {policySaving ? "저장 중..." : "정책 저장"}
            </button>
          </div>
        </div>
        {policyLoading ? (
          <p className="text-sm text-stone-600">보안 정책 로딩 중...</p>
        ) : (
          <div className="space-y-2">
            <div className="grid gap-2 md:grid-cols-4">
              <label className="space-y-1 text-xs">
                <span className="text-stone-600">최소 길이</span>
                <input
                  type="number"
                  min={6}
                  max={128}
                  className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                  value={policyDraft.password_min_length}
                  onChange={(e) =>
                    setPolicyDraft((prev) => ({
                      ...prev,
                      password_min_length: Number(e.target.value) || 0,
                    }))
                  }
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-stone-600">로그인 실패 허용 횟수</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                  value={policyDraft.max_failed_attempts}
                  onChange={(e) =>
                    setPolicyDraft((prev) => ({
                      ...prev,
                      max_failed_attempts: Number(e.target.value) || 0,
                    }))
                  }
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-stone-600">잠금 시간(초)</span>
                <input
                  type="number"
                  min={60}
                  max={86400}
                  className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                  value={policyDraft.lockout_seconds}
                  onChange={(e) =>
                    setPolicyDraft((prev) => ({
                      ...prev,
                      lockout_seconds: Number(e.target.value) || 0,
                    }))
                  }
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-stone-600">자동 로그인 기간(일)</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                  value={policyDraft.auto_login_days}
                  onChange={(e) =>
                    setPolicyDraft((prev) => ({
                      ...prev,
                      auto_login_days: Number(e.target.value) || 0,
                    }))
                  }
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-stone-700">
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={policyDraft.require_uppercase}
                  onChange={(e) =>
                    setPolicyDraft((prev) => ({ ...prev, require_uppercase: e.target.checked }))
                  }
                />
                대문자 필수
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={policyDraft.require_lowercase}
                  onChange={(e) =>
                    setPolicyDraft((prev) => ({ ...prev, require_lowercase: e.target.checked }))
                  }
                />
                소문자 필수
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={policyDraft.require_digit}
                  onChange={(e) =>
                    setPolicyDraft((prev) => ({ ...prev, require_digit: e.target.checked }))
                  }
                />
                숫자 필수
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={policyDraft.require_special}
                  onChange={(e) =>
                    setPolicyDraft((prev) => ({ ...prev, require_special: e.target.checked }))
                  }
                />
                특수문자 필수
              </label>
            </div>
            <p className="text-xs text-stone-600">{formatPolicySummary(policyDraft)}</p>
          </div>
        )}
      </article>

      <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
        <h2 className="mb-3 inline-flex items-center gap-1 text-sm font-semibold">
          <User className="h-4 w-4 text-accent" />
          사용자 생성
        </h2>
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_180px_auto]">
          <input
            className="rounded border border-stone-300 px-3 py-2 text-sm"
            placeholder="아이디"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
          />
          <input
            type="password"
            className="rounded border border-stone-300 px-3 py-2 text-sm"
            placeholder="비밀번호"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <input
            type="password"
            className="rounded border border-stone-300 px-3 py-2 text-sm"
            placeholder="비밀번호 확인"
            value={newPasswordConfirm}
            onChange={(e) => setNewPasswordConfirm(e.target.value)}
          />
          <select
            className="rounded border border-stone-300 px-2 py-2 text-sm"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as UserRole)}
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {userRoleLabel(role)}
              </option>
            ))}
          </select>
          <button
            className="inline-flex items-center justify-center gap-1 rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-60"
            onClick={createUser}
            disabled={creating}
          >
            <Users className="h-4 w-4" />
            {creating ? "생성 중..." : "사용자 생성"}
          </button>
        </div>
        <p className="mt-2 text-xs text-stone-600">
          {formatPolicySummary(policy)}
        </p>
      </article>

      <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-1 text-sm font-semibold">
            <Users className="h-4 w-4 text-accent" />
            사용자 목록
          </h2>
          <div className="flex gap-1">
            <button className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50" onClick={applySearch}>
              <Search className="h-3.5 w-3.5" />
              검색 적용
            </button>
            <button className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50" onClick={clearFilters}>
              <RefreshCcw className="h-3.5 w-3.5" />
              초기화
            </button>
            <button className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50" onClick={() => void loadUsers()}>
              <RefreshCcw className="h-3.5 w-3.5" />
              새로고침
            </button>
          </div>
        </div>

        <div className="mb-3 grid gap-2 md:grid-cols-[1fr_160px_160px_auto]">
          <input
            className="rounded border border-stone-300 px-3 py-2 text-sm"
            placeholder="아이디 검색"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
          />
          <select
            className="rounded border border-stone-300 px-2 py-2 text-sm"
            value={roleFilter}
            onChange={(e) => {
              setRoleFilter((e.target.value as UserRole | "") || "");
              setPage(1);
            }}
          >
            <option value="">역할 전체</option>
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {userRoleLabel(role)}
              </option>
            ))}
          </select>
          <select
            className="rounded border border-stone-300 px-2 py-2 text-sm"
            value={activeFilter}
            onChange={(e) => {
              setActiveFilter((e.target.value as "" | "true" | "false") || "");
              setPage(1);
            }}
          >
            <option value="">상태 전체</option>
            <option value="true">활성</option>
            <option value="false">비활성</option>
          </select>
          <p className="self-center text-xs text-stone-600">
            총 {total.toLocaleString("ko-KR")}건 | 페이지 {page}/{totalPages}
          </p>
        </div>

        {message ? <p className="mb-2 text-sm text-emerald-700">{message}</p> : null}
        {error ? <p className="mb-2 text-sm text-red-700">{error}</p> : null}
        {loading ? <p className="text-sm text-stone-600">사용자 목록 로딩 중...</p> : null}

        {!loading ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-stone-500">
                  <th className="py-2">아이디</th>
                  <th className="py-2">권한</th>
                  <th className="py-2">활성</th>
                  <th className="py-2">생성일</th>
                  <th className="py-2">최근 로그인</th>
                  <th className="py-2">보안 상태</th>
                  <th className="py-2">작업</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td className="py-3 text-stone-600" colSpan={7}>
                      사용자 없음
                    </td>
                  </tr>
                ) : null}

                {users.map((user) => (
                  <tr key={user.id} className="border-b border-stone-100">
                    <td className="py-2 font-medium text-stone-900">{user.username}</td>
                    <td className="py-2">
                      <select
                        className="rounded border border-stone-300 px-2 py-1 text-xs"
                        value={roleDrafts[user.id] ?? user.role}
                        onChange={(e) =>
                          setRoleDrafts((prev) => ({ ...prev, [user.id]: e.target.value as UserRole }))
                        }
                      >
                        {ROLE_OPTIONS.map((role) => (
                          <option key={role} value={role}>
                            {userRoleLabel(role)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2">{user.is_active ? "활성" : "비활성"}</td>
                    <td className="py-2 text-xs text-stone-600">{formatDateTime(user.created_at)}</td>
                    <td className="py-2 text-xs text-stone-600">{formatDateTime(user.last_login_at)}</td>
                    <td className="py-2 text-xs">
                      {user.locked_until ? (
                        <span className="rounded bg-red-50 px-2 py-1 text-red-700">
                          잠금 ({formatDateTime(user.locked_until)})
                        </span>
                      ) : user.failed_login_attempts > 0 ? (
                        <span className="rounded bg-amber-50 px-2 py-1 text-amber-700">
                          실패 {user.failed_login_attempts}회
                        </span>
                      ) : (
                        <span className="text-stone-500">정상</span>
                      )}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        <button
                          className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
                          disabled={busyUserId === user.id || roleDrafts[user.id] === user.role}
                          onClick={() =>
                            void updateUser(
                              user.id,
                              { role: roleDrafts[user.id] ?? user.role },
                              `역할 변경 완료: ${user.username}`,
                            )
                          }
                        >
                          역할 저장
                        </button>
                        <button
                          className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
                          disabled={busyUserId === user.id}
                          onClick={() =>
                            void updateUser(
                              user.id,
                              { is_active: !user.is_active },
                              `${user.username} ${user.is_active ? "비활성화" : "활성화"} 완료`,
                            )
                          }
                        >
                          {user.is_active ? "비활성화" : "활성화"}
                        </button>
                        <input
                          type="password"
                          className="rounded border border-stone-300 px-2 py-1 text-xs"
                          placeholder={`새 비밀번호(${policy.password_min_length}+)`}
                          value={passwordDrafts[user.id] ?? ""}
                          onChange={(e) =>
                            setPasswordDrafts((prev) => ({
                              ...prev,
                              [user.id]: e.target.value,
                            }))
                          }
                        />
                        <input
                          type="password"
                          className="rounded border border-stone-300 px-2 py-1 text-xs"
                          placeholder="비밀번호 확인"
                          value={passwordConfirmDrafts[user.id] ?? ""}
                          onChange={(e) =>
                            setPasswordConfirmDrafts((prev) => ({
                              ...prev,
                              [user.id]: e.target.value,
                            }))
                          }
                        />
                        <button
                          className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
                          disabled={
                            busyUserId === user.id ||
                            !(passwordDrafts[user.id] || "").trim() ||
                            !(passwordConfirmDrafts[user.id] || "").trim()
                          }
                          onClick={() => void resetPassword(user)}
                        >
                          비밀번호 재설정
                        </button>
                        <button
                          className="rounded border border-amber-300 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                          disabled={busyUserId === user.id || !user.locked_until}
                          onClick={() =>
                            void updateUser(
                              user.id,
                              { unlock_account: true },
                              `잠금 해제 완료: ${user.username}`,
                            )
                          }
                        >
                          잠금 해제
                        </button>
                        <button
                          className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                          disabled={busyUserId === user.id || user.id === currentUserId}
                          onClick={() => void deleteUser(user)}
                          title={user.id === currentUserId ? "현재 로그인 사용자 삭제 불가" : "사용자 삭제"}
                        >
                          계정 삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </article>

      <div className="flex justify-end gap-2">
        <button
          className="rounded border border-stone-300 px-3 py-1 text-sm disabled:opacity-50"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
        >
          이전
        </button>
        <button
          className="rounded border border-stone-300 px-3 py-1 text-sm disabled:opacity-50"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
        >
          다음
        </button>
      </div>
    </section>
  );
}
